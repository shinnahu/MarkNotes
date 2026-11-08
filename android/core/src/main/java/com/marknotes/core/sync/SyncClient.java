package com.marknotes.core.sync;

import java.io.Closeable;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.marknotes.core.Json;
import com.marknotes.core.Lang;

/** One connection to MarkNotes on a PC: pairing, then sync requests one at a time (PROTOCOL.md §4–5). */
final class SyncClient implements Closeable {
    /** A request the PC refused ({@link #code}: changed, missing, badPath, busy…). */
    static final class Refused extends IOException {
        final String code;

        Refused(String code, String message) {
            super(message == null || message.isEmpty() ? code : message);
            this.code = code == null ? "" : code;
        }
    }

    /** The PC said no at AUTH or pairing ({@link #status} = Proto.ST_*). */
    static final class AuthFailed extends IOException {
        final int status;

        AuthFailed(int status, String message) {
            super(message == null || message.isEmpty() ? defaultText(status) : message);
            this.status = status;
        }

        static String defaultText(int status) {
            switch (status) {
                case Proto.ST_UNKNOWN_DEVICE:
                case Proto.ST_BAD_TOKEN:
                    return Lang.t("The PC doesn't know this phone any more. Pair it again.", "La PC ya no reconoce este teléfono. Vinculalo de nuevo.");
                case Proto.ST_BUSY: return Lang.t("Another phone is syncing with the PC.", "Otro teléfono se está sincronizando con la PC.");
                case Proto.ST_PAIRING_CLOSED:
                    return Lang.t("On the PC, open MarkNotes › Settings › Phone and click Pair a phone.", "En la PC, abrí MarkNotes › Configuración › Teléfono y hacé clic en Vincular un teléfono.");
                case Proto.ST_DENIED: return Lang.t("The PC didn't allow this phone.", "La PC no permitió este teléfono.");
                case Proto.ST_RATE_LIMITED: return Lang.t("Too many tries. Wait 10 minutes.", "Demasiados intentos. Esperá 10 minutos.");
                default: return Lang.t("The PC refused the connection.", "La PC rechazó la conexión.");
            }
        }
    }

    private final SecureChannel ch;

    private SyncClient(SecureChannel ch) { this.ch = ch; }

    String address() { return ch.address; }

    String remoteIp() { return ch.remoteIp(); }

    // ─────────────────────────── connecting ───────────────────────────

    private static SecureChannel open(String address, int port, String pinnedFp, int timeoutMs) throws IOException {
        String host = address;
        int p = port;
        int colon = address.lastIndexOf(':');
        if (colon > 0 && address.indexOf(':') == colon) {
            host = address.substring(0, colon);
            try { p = Integer.parseInt(address.substring(colon + 1)); } catch (NumberFormatException ignored) {}
        }
        InetAddress ip = InetAddress.getByName(host);
        Socket s = new Socket();
        try {
            s.connect(new InetSocketAddress(ip, p), timeoutMs);
        } catch (IOException e) {
            try { s.close(); } catch (IOException ignored) {}
            throw e;
        }
        return SecureChannel.handshake(s, pinnedFp, address);
    }

    /** Opens an authenticated connection to a paired PC: its last address first, then the others, then a Wi-Fi search. */
    static SyncClient connect(PairedPc pc, String deviceName) throws IOException {
        Set<String> tried = new LinkedHashSet<>();
        List<String> order = new ArrayList<>();
        if (!pc.lastAddress.isEmpty()) order.add(pc.lastAddress);
        order.addAll(pc.addresses);
        IOException last = null;
        for (String a : order) {
            if (!tried.add(a)) continue;
            try {
                return auth(open(a, pc.port, pc.fingerprint, 2500), pc, deviceName);
            } catch (SecureChannel.IdentityChanged | AuthFailed e) {
                throw e;
            } catch (IOException e) {
                last = e;
            }
        }
        // The PC may have a new address (DHCP): find it by its id.
        for (Discovery.Found f : Discovery.scan(Discovery.broadcastTargets(), pc.port, 1500)) {
            if (!f.id.equalsIgnoreCase(pc.hostId) || !tried.add(f.address)) continue;
            try {
                return auth(open(f.address, f.port, pc.fingerprint, 2500), pc, deviceName);
            } catch (SecureChannel.IdentityChanged | AuthFailed e) {
                throw e;
            } catch (IOException e) {
                last = e;
            }
        }
        throw new IOException(Lang.t("Can't reach " + pc.name + ". Make sure MarkNotes is open on the PC and both are on the same Wi-Fi.",
                "No se encuentra " + pc.name + ". Fijate que MarkNotes esté abierto en la PC y que los dos estén en el mismo Wi-Fi."), last);
    }

    private static SyncClient auth(SecureChannel ch, PairedPc pc, String deviceName) throws IOException {
        boolean ok = false;
        try {
            ch.setReadTimeout(20_000);
            ch.send(Proto.AUTH, new Bytes.Writer().bytes(pc.deviceId).bytes(pc.token).str(deviceName).u16(Proto.VERSION).done());
            byte[] m = ch.receive();
            if ((m[0] & 0xFF) != Proto.AUTH_RESULT) throw new IOException("Unexpected answer from the PC");
            Bytes.Reader r = new Bytes.Reader(m, 1);
            int st = r.u8();
            String msg = r.remaining() >= 2 ? r.str() : "";
            if (st != Proto.ST_OK) throw new AuthFailed(st, msg);
            ch.setReadTimeout(120_000);
            ok = true;
            return new SyncClient(ch);
        } finally {
            if (!ok) ch.close();
        }
    }

    interface CodeListener {
        void onCode(String code);
    }

    /** Pairs with the PC at {@code address}: shows the code through {@code l}, waits for Allow on the PC. */
    static PairedPc pair(String address, int port, String deviceName, String model, CodeListener l) throws IOException {
        SecureChannel ch = open(address, port, null, 4000);
        try {
            ch.setReadTimeout(20_000);
            byte[] nonceC = Crypto.random(32);
            ch.send(Proto.PAIR_REQUEST, new Bytes.Writer().bytes(Crypto.sha256(nonceC)).str(deviceName).str(model).done());
            byte[] m = ch.receive();
            int type = m[0] & 0xFF;
            if (type == Proto.PAIR_RESULT) {
                Bytes.Reader r = new Bytes.Reader(m, 1);
                int st = r.u8();
                throw new AuthFailed(st == Proto.ST_OK ? Proto.ST_DENIED : st, r.remaining() >= 2 ? r.str() : "");
            }
            if (type != Proto.PAIR_CHALLENGE) throw new IOException("Unexpected answer from the PC");
            byte[] nonceH = new Bytes.Reader(m, 1).bytes(32);
            ch.send(Proto.PAIR_REVEAL, nonceC);
            if (l != null) l.onCode(Crypto.pairingCode(ch.transcriptHash, nonceC, nonceH));
            ch.setReadTimeout(150_000);
            m = ch.receive();
            if ((m[0] & 0xFF) != Proto.PAIR_RESULT) throw new IOException("Unexpected answer from the PC");
            Bytes.Reader r = new Bytes.Reader(m, 1);
            int st = r.u8();
            if (st != Proto.ST_OK) throw new AuthFailed(st, r.remaining() >= 2 ? r.str() : "");
            PairedPc pc = new PairedPc();
            pc.deviceId = r.bytes(16);
            pc.token = r.bytes(32);
            pc.hostId = Bytes.hex(r.bytes(16));
            pc.name = r.str();
            pc.fingerprint = ch.fingerprint;
            pc.port = port;
            pc.addAddress(address);
            pc.lastAddress = address;
            pc.pairedAt = System.currentTimeMillis();
            return pc;
        } finally {
            ch.close();
        }
    }

    // ─────────────────────────── requests ───────────────────────────

    private byte[] expect(int... types) throws IOException {
        byte[] m = ch.receive();
        int t = m[0] & 0xFF;
        for (int x : types) if (x == t) return m;
        if (t == Proto.BYE) throw new IOException(Lang.t("The PC ended the sync.", "La PC terminó la sincronización."));
        throw new IOException("Unexpected message " + t);
    }

    private Map<String, Object> response() throws IOException {
        byte[] m = expect(Proto.RESPONSE);
        Map<String, Object> res = Json.parseObject(new String(m, 1, m.length - 1, StandardCharsets.UTF_8));
        if (!Json.getBool(res, "ok", false)) throw new Refused(Json.getString(res, "code", "error"), Json.getString(res, "error", ""));
        return res;
    }

    private void sendRequest(Map<String, Object> req) throws IOException {
        ch.send(Proto.REQUEST, Json.write(req).getBytes(StandardCharsets.UTF_8));
    }

    Map<String, Object> request(Map<String, Object> req) throws IOException {
        sendRequest(req);
        return response();
    }

    /**
     * Downloads a file into {@code out}. Returns the PC's {s, m, h}; throws Refused("corrupt") when the bytes don't
     * match the hash (the file changed on the PC while it was sent).
     */
    Map<String, Object> get(String ws, String p, OutputStream out) throws IOException {
        sendRequest(Json.obj("op", "get", "ws", ws, "p", p));
        Map<String, Object> res = response();
        MessageDigest md = sha();
        long got = 0;
        while (true) {
            byte[] m = expect(Proto.DATA_DOWN, Proto.END_DOWN);
            if ((m[0] & 0xFF) == Proto.END_DOWN) break;
            md.update(m, 1, m.length - 1);
            out.write(m, 1, m.length - 1);
            got += m.length - 1;
        }
        String h = Bytes.hex(md.digest());
        if (got != Json.getLong(res, "s", -1) || !h.equals(Json.getString(res, "h", ""))) {
            throw new Refused("corrupt", Lang.t("The file changed on the PC while it was copied.", "El archivo cambió en la PC mientras se copiaba."));
        }
        return res;
    }

    /** The sync run the PC keeps its replaced and deleted versions under (null: a PC that doesn't keep them). */
    String run;

    private Map<String, Object> withRun(Map<String, Object> req) {
        if (run != null) req.put("run", run);
        return req;
    }

    /** Deletes a file on the PC (into its Recycle Bin, a copy kept under {@link #run}). */
    void delete(String ws, String p, String base) throws IOException {
        request(withRun(Json.obj("op", "delete", "ws", ws, "p", p, "base", base)));
    }

    /** Uploads a file. Returns the hash the PC will list for it. */
    String put(String ws, String p, File f, long size, long mtime, String hash, String base) throws IOException {
        sendRequest(withRun(Json.obj("op", "put", "ws", ws, "p", p, "s", size, "m", mtime, "h", hash, "base", base)));
        byte[] buf = new byte[Proto.CHUNK];
        long left = size;
        try (InputStream in = new FileInputStream(f)) {
            while (left > 0) {
                int n = in.read(buf, 0, (int) Math.min(buf.length, left));
                if (n <= 0) break;
                ch.send(Proto.DATA_UP, buf, 0, n);
                left -= n;
            }
        }
        ch.send(Proto.END_UP, new byte[0]);
        return Json.getString(response(), "h", hash);
    }

    /** Uploads bytes held in memory (workspace settings). */
    String put(String ws, String p, byte[] data, long mtime, String base) throws IOException {
        String hash = Bytes.hex(Crypto.sha256(data));
        sendRequest(withRun(Json.obj("op", "put", "ws", ws, "p", p, "s", (long) data.length, "m", mtime, "h", hash, "base", base)));
        for (int off = 0; off < data.length; off += Proto.CHUNK) {
            ch.send(Proto.DATA_UP, data, off, Math.min(Proto.CHUNK, data.length - off));
        }
        ch.send(Proto.END_UP, new byte[0]);
        return Json.getString(response(), "h", hash);
    }

    static MessageDigest sha() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    void bye() {
        try { ch.send(Proto.BYE, new Bytes.Writer().u8(0).str("").done()); } catch (IOException ignored) {}
    }

    @Override
    public void close() { ch.close(); }
}
