package com.marknotes.core.sync;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.Closeable;
import java.io.DataInputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.OutputStream;
import java.net.Socket;
import java.net.SocketException;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.PublicKey;
import java.util.Arrays;

import javax.crypto.AEADBadTagException;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/** The phone's end of the encrypted channel to MarkNotes on the PC (PROTOCOL.md §2–3). */
final class SecureChannel implements Closeable {
    static final int HANDSHAKE_TIMEOUT_MS = 8000;

    /** The PC's key is not the one pinned when the phone paired. */
    static final class IdentityChanged extends IOException {
        IdentityChanged() { super("The PC's identity changed"); }
    }

    private final Socket socket;
    private final DataInputStream in;
    private final OutputStream out;
    private final Object sendLock = new Object();
    private final Object recvLock = new Object();
    private final Cipher enc;
    private final Cipher dec;
    private final SecretKeySpec sendKey;
    private final SecretKeySpec recvKey;
    private long sendSeq;
    private long recvSeq;
    final byte[] transcriptHash;
    final String fingerprint;
    final String address;
    private volatile boolean closed;

    private SecureChannel(Socket socket, DataInputStream in, OutputStream out, byte[] k1, byte[] k2, byte[] th, String fp, String address)
            throws GeneralSecurityException {
        this.socket = socket;
        this.in = in;
        this.out = out;
        this.sendKey = new SecretKeySpec(k1, "AES");
        this.recvKey = new SecretKeySpec(k2, "AES");
        this.enc = Cipher.getInstance("AES/GCM/NoPadding");
        this.dec = Cipher.getInstance("AES/GCM/NoPadding");
        this.transcriptHash = th;
        this.fingerprint = fp;
        this.address = address;
    }

    /** Runs the handshake on a connected socket. {@code pinnedFp} = the paired PC's fingerprint, or null while pairing. */
    static SecureChannel handshake(Socket socket, String pinnedFp, String address) throws IOException {
        boolean ok = false;
        try {
            socket.setTcpNoDelay(true);
            socket.setKeepAlive(true);
            socket.setSoTimeout(HANDSHAKE_TIMEOUT_MS);
            DataInputStream in = new DataInputStream(new BufferedInputStream(socket.getInputStream(), 64 * 1024));
            OutputStream out = new BufferedOutputStream(socket.getOutputStream(), 64 * 1024);

            KeyPair eph = Crypto.newP256KeyPair();
            byte[] ch = new Bytes.Writer().bytes(Proto.MAGIC).u8(Proto.VERSION).bytes(Crypto.encodePoint(eph.getPublic()))
                    .bytes(Crypto.random(32)).done();
            out.write(new Bytes.Writer().i32(ch.length).bytes(ch).done());
            out.flush();

            int len = in.readInt();
            if (len != Proto.SERVER_HELLO_LEN) throw new IOException("Not MarkNotes on the other side");
            byte[] sh = new byte[len];
            in.readFully(sh);
            if (!Arrays.equals(Arrays.copyOfRange(sh, 0, 4), Proto.MAGIC)) throw new IOException("Not MarkNotes on the other side");
            if ((sh[4] & 0xFF) != Proto.VERSION) throw new IOException("MarkNotes on the PC speaks another sync version");
            byte[] hostEph = Arrays.copyOfRange(sh, 5, 70);
            byte[] hostStatic = Arrays.copyOfRange(sh, 102, 167);
            byte[] sig = Arrays.copyOfRange(sh, 167, 231);
            PublicKey hostKey = Crypto.decodePoint(hostStatic);
            byte[] signed = Bytes.cat(ch, Arrays.copyOfRange(sh, 0, Proto.SERVER_HELLO_SIGNED_LEN));
            if (!Crypto.verifyP256(hostKey, signed, sig)) throw new IOException("The PC's signature is invalid");
            String fp = Bytes.hex(Crypto.sha256(hostStatic));
            if (pinnedFp != null && !pinnedFp.isEmpty() && !pinnedFp.equalsIgnoreCase(fp)) throw new IdentityChanged();

            byte[] z = Crypto.ecdh(eph.getPrivate(), Crypto.decodePoint(hostEph));
            byte[] th = Crypto.sha256(ch, sh);
            byte[][] keys = Crypto.sessionKeys(th, z);
            SecureChannel c = new SecureChannel(socket, in, out, keys[0], keys[1], th, fp, address);
            ok = true;
            return c;
        } catch (GeneralSecurityException e) {
            throw new IOException("Crypto failure: " + e.getMessage(), e);
        } finally {
            if (!ok) {
                try { socket.close(); } catch (IOException ignored) {}
            }
        }
    }

    private static byte[] nonce(long seq) {
        byte[] n = new byte[12];
        for (int i = 0; i < 8; i++) n[4 + i] = (byte) (seq >>> (56 - 8 * i));
        return n;
    }

    void send(int type, byte[] payload) throws IOException {
        send(type, payload, 0, payload == null ? 0 : payload.length);
    }

    /** Encrypts and writes one record (u8 type ‖ payload). */
    void send(int type, byte[] payload, int off, int n) throws IOException {
        synchronized (sendLock) {
            if (closed) throw new SocketException("channel closed");
            byte[] plain = new byte[1 + n];
            plain[0] = (byte) type;
            if (n > 0) System.arraycopy(payload, off, plain, 1, n);
            int ctLen = plain.length + 16;
            if (ctLen > Proto.MAX_RECORD) throw new IOException("record too large");
            byte[] rec = new byte[4 + ctLen];
            rec[0] = (byte) (ctLen >>> 24);
            rec[1] = (byte) (ctLen >>> 16);
            rec[2] = (byte) (ctLen >>> 8);
            rec[3] = (byte) ctLen;
            try {
                enc.init(Cipher.ENCRYPT_MODE, sendKey, new GCMParameterSpec(128, nonce(sendSeq++)));
                enc.updateAAD(rec, 0, 4);
                int w = enc.doFinal(plain, 0, plain.length, rec, 4);
                if (w != ctLen) throw new IOException("unexpected ciphertext length");
            } catch (GeneralSecurityException e) {
                throw new IOException("encrypt failed: " + e.getMessage(), e);
            }
            out.write(rec);
            out.flush();
        }
    }

    /** Reads one record; [0] is the type. */
    byte[] receive() throws IOException {
        synchronized (recvLock) {
            int len;
            try {
                len = in.readInt();
            } catch (EOFException e) {
                throw new EOFException("The PC closed the connection");
            }
            if (len < 17 || len > Proto.MAX_RECORD) throw new IOException("bad record length " + len);
            byte[] ct = new byte[len];
            in.readFully(ct);
            byte[] hdr = {(byte) (len >>> 24), (byte) (len >>> 16), (byte) (len >>> 8), (byte) len};
            try {
                dec.init(Cipher.DECRYPT_MODE, recvKey, new GCMParameterSpec(128, nonce(recvSeq++)));
                dec.updateAAD(hdr);
                byte[] p = dec.doFinal(ct);
                if (p.length == 0) throw new IOException("empty record");
                return p;
            } catch (AEADBadTagException e) {
                throw new IOException("record authentication failed");
            } catch (GeneralSecurityException e) {
                throw new IOException("decrypt failed: " + e.getMessage(), e);
            }
        }
    }

    void setReadTimeout(int ms) {
        try { socket.setSoTimeout(ms); } catch (SocketException ignored) {}
    }

    String remoteIp() {
        return socket.getInetAddress() == null ? address : socket.getInetAddress().getHostAddress();
    }

    @Override
    public void close() {
        closed = true;
        try { socket.close(); } catch (IOException ignored) {}
    }
}
