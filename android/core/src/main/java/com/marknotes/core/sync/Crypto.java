package com.marknotes.core.sync;

import java.io.ByteArrayOutputStream;
import java.math.BigInteger;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.X509EncodedKeySpec;
import java.util.Locale;

import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** P-256 / SHA-256 / HMAC helpers (standard Java crypto, works on Android 8+ and desktop JDKs). */
final class Crypto {
    private Crypto() {}

    private static final SecureRandom RNG = new SecureRandom();

    /** DER SubjectPublicKeyInfo prefix of an uncompressed P-256 point (the 65 point bytes follow). */
    private static final byte[] P256_SPKI_PREFIX = Bytes.unhex("3059301306072a8648ce3d020106082a8648ce3d030107034200");

    static byte[] random(int n) {
        byte[] b = new byte[n];
        RNG.nextBytes(b);
        return b;
    }

    static byte[] sha256(byte[]... parts) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            for (byte[] p : parts) md.update(p);
            return md.digest();
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    static byte[] hmac(byte[] key, byte[]... parts) {
        try {
            Mac m = Mac.getInstance("HmacSHA256");
            m.init(new SecretKeySpec(key, "HmacSHA256"));
            for (byte[] p : parts) m.update(p);
            return m.doFinal();
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    static KeyPair newP256KeyPair() {
        try {
            KeyPairGenerator g = KeyPairGenerator.getInstance("EC");
            g.initialize(new ECGenParameterSpec("secp256r1"), RNG);
            return g.generateKeyPair();
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Uncompressed point 04 ‖ X ‖ Y (65 bytes). */
    static byte[] encodePoint(PublicKey pub) {
        ECPoint w = ((ECPublicKey) pub).getW();
        byte[] out = new byte[65];
        out[0] = 4;
        System.arraycopy(leftPad(w.getAffineX().toByteArray(), 32), 0, out, 1, 32);
        System.arraycopy(leftPad(w.getAffineY().toByteArray(), 32), 0, out, 33, 32);
        return out;
    }

    static PublicKey decodePoint(byte[] p65) throws GeneralSecurityException {
        if (p65 == null || p65.length != 65 || p65[0] != 4) throw new GeneralSecurityException("bad P-256 point");
        return KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(Bytes.cat(P256_SPKI_PREFIX, p65)));
    }

    /** ECDH shared secret = the 32-byte big-endian X coordinate. */
    static byte[] ecdh(PrivateKey priv, PublicKey peer) throws GeneralSecurityException {
        KeyAgreement ka = KeyAgreement.getInstance("ECDH");
        ka.init(priv);
        ka.doPhase(peer, true);
        return leftPad(ka.generateSecret(), 32);
    }

    /** Checks a raw r ‖ s (64 bytes) ECDSA-P256-SHA256 signature. */
    static boolean verifyP256(PublicKey pub, byte[] msg, byte[] rawSig) throws GeneralSecurityException {
        if (rawSig == null || rawSig.length != 64) return false;
        Signature s = Signature.getInstance("SHA256withECDSA");
        s.initVerify(pub);
        s.update(msg);
        return s.verify(rawToDer(rawSig));
    }

    /** {K1 phone→PC, K2 PC→phone} from the transcript hash and the ECDH secret (PROTOCOL.md §2). */
    static byte[][] sessionKeys(byte[] th, byte[] z) {
        byte[] prk = hmac(th, z);
        byte[] k1 = hmac(prk, Proto.KEYS_INFO, new byte[] {1});
        byte[] k2 = hmac(prk, k1, Proto.KEYS_INFO, new byte[] {2});
        return new byte[][] {k1, k2};
    }

    /** The 6-digit code both sides show while pairing, as "123 456". */
    static String pairingCode(byte[] th, byte[] nonceC, byte[] nonceH) {
        byte[] d = sha256(Proto.SAS_LABEL, th, nonceC, nonceH);
        long v = ((d[0] & 0xFFL) << 24) | ((d[1] & 0xFFL) << 16) | ((d[2] & 0xFFL) << 8) | (d[3] & 0xFFL);
        String s = String.format(Locale.US, "%06d", v % 1_000_000L);
        return s.substring(0, 3) + " " + s.substring(3);
    }

    static byte[] leftPad(byte[] b, int n) {
        if (b.length == n) return b;
        byte[] out = new byte[n];
        if (b.length > n) System.arraycopy(b, b.length - n, out, 0, n);
        else System.arraycopy(b, 0, out, n - b.length, b.length);
        return out;
    }

    static byte[] rawToDer(byte[] rs) {
        byte[] r = derInt(rs, 0);
        byte[] s = derInt(rs, 32);
        ByteArrayOutputStream o = new ByteArrayOutputStream(72);
        o.write(0x30);
        o.write(2 + r.length + 2 + s.length);
        o.write(0x02);
        o.write(r.length);
        o.write(r, 0, r.length);
        o.write(0x02);
        o.write(s.length);
        o.write(s, 0, s.length);
        return o.toByteArray();
    }

    private static byte[] derInt(byte[] rs, int off) {
        int i = off;
        int end = off + 32;
        while (i < end - 1 && rs[i] == 0) i++;
        boolean pad = (rs[i] & 0x80) != 0;
        byte[] out = new byte[(end - i) + (pad ? 1 : 0)];
        System.arraycopy(rs, i, out, pad ? 1 : 0, end - i);
        return out;
    }

    @SuppressWarnings("unused")
    private static BigInteger unused() { return BigInteger.ZERO; }
}
