package com.marknotes.core.sync;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/** Big-endian message building and reading (str = u16 length + UTF-8). */
final class Bytes {
    private Bytes() {}

    static final char[] HEX = "0123456789abcdef".toCharArray();

    static String hex(byte[] b) {
        char[] c = new char[b.length * 2];
        for (int i = 0; i < b.length; i++) {
            c[2 * i] = HEX[(b[i] >> 4) & 15];
            c[2 * i + 1] = HEX[b[i] & 15];
        }
        return new String(c);
    }

    static byte[] unhex(String s) {
        if (s == null || (s.length() & 1) != 0) throw new IllegalArgumentException("bad hex");
        byte[] b = new byte[s.length() / 2];
        for (int i = 0; i < b.length; i++) b[i] = (byte) Integer.parseInt(s.substring(2 * i, 2 * i + 2), 16);
        return b;
    }

    static byte[] cat(byte[]... parts) {
        int n = 0;
        for (byte[] p : parts) n += p.length;
        byte[] o = new byte[n];
        int i = 0;
        for (byte[] p : parts) {
            System.arraycopy(p, 0, o, i, p.length);
            i += p.length;
        }
        return o;
    }

    static final class Writer {
        private final ByteArrayOutputStream o = new ByteArrayOutputStream(128);

        Writer u8(int v) { o.write(v & 0xFF); return this; }

        Writer u16(int v) { o.write((v >>> 8) & 0xFF); o.write(v & 0xFF); return this; }

        Writer i32(int v) { o.write(v >>> 24); o.write(v >>> 16); o.write(v >>> 8); o.write(v); return this; }

        Writer bytes(byte[] b) { o.write(b, 0, b.length); return this; }

        Writer str(String s) {
            byte[] b = (s == null ? "" : s).getBytes(StandardCharsets.UTF_8);
            int n = Math.min(b.length, 0xFFFF);
            u16(n);
            o.write(b, 0, n);
            return this;
        }

        byte[] done() { return o.toByteArray(); }
    }

    static final class Reader {
        private final byte[] b;
        private int p;

        Reader(byte[] b, int offset) { this.b = b; this.p = offset; }

        int remaining() { return b.length - p; }

        private void need(int n) throws IOException {
            if (p + n > b.length) throw new IOException("message too short");
        }

        int u8() throws IOException { need(1); return b[p++] & 0xFF; }

        int u16() throws IOException { need(2); int v = ((b[p] & 0xFF) << 8) | (b[p + 1] & 0xFF); p += 2; return v; }

        byte[] bytes(int n) throws IOException {
            need(n);
            byte[] r = new byte[n];
            System.arraycopy(b, p, r, 0, n);
            p += n;
            return r;
        }

        String str() throws IOException {
            int n = u16();
            need(n);
            String s = new String(b, p, n, StandardCharsets.UTF_8);
            p += n;
            return s;
        }
    }
}
