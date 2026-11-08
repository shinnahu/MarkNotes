package com.marknotes.core.sync;

import java.io.IOException;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.marknotes.core.Json;

/** Finds MarkNotes PCs on the Wi-Fi (UDP, PROTOCOL.md §1). */
public final class Discovery {
    private Discovery() {}

    private static final int[] SEND_AT_MS = {0, 300, 800};

    public static final class Found {
        public String id = "";
        public String name = "";
        public String fingerprint = "";
        public String address = "";
        public int port = Proto.DEFAULT_PORT;
        public boolean pairing;

        public Map<String, Object> toJson() {
            return Json.obj("id", id, "name", name, "address", address, "port", (long) port, "pairing", pairing,
                    "fingerprint", shortFp(fingerprint));
        }
    }

    /** "AB12-CD34-EF56", as the PC shows it. */
    public static String shortFp(String fp) {
        if (fp == null || fp.length() < 12) return fp == null ? "" : fp;
        return (fp.substring(0, 4) + "-" + fp.substring(4, 8) + "-" + fp.substring(8, 12)).toUpperCase(java.util.Locale.ROOT);
    }

    /** 255.255.255.255 plus the broadcast address of every IPv4 network the phone is on. */
    public static List<InetAddress> broadcastTargets() {
        LinkedHashSet<InetAddress> out = new LinkedHashSet<>();
        try {
            out.add(InetAddress.getByName("255.255.255.255"));
        } catch (IOException ignored) {
        }
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                try {
                    if (!ni.isUp() || ni.isLoopback()) continue;
                } catch (IOException e) {
                    continue;
                }
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    if (ia.getAddress() instanceof Inet4Address && ia.getBroadcast() != null) out.add(ia.getBroadcast());
                }
            }
        } catch (IOException | RuntimeException ignored) {
        }
        return new ArrayList<>(out);
    }

    /** Sends the question (three times) and collects answers for {@code durationMs}. Blocking. */
    public static List<Found> scan(Collection<InetAddress> targets, int port, int durationMs) {
        List<Found> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        DatagramSocket s = null;
        try {
            s = new DatagramSocket();
            s.setBroadcast(true);
            s.setSoTimeout(100);
            long start = System.currentTimeMillis();
            int next = 0;
            byte[] buf = new byte[4096];
            while (true) {
                long el = System.currentTimeMillis() - start;
                if (el >= durationMs) break;
                while (next < SEND_AT_MS.length && el >= SEND_AT_MS[next]) {
                    for (InetAddress t : targets) {
                        try {
                            s.send(new DatagramPacket(Proto.DISCOVERY_REQUEST, Proto.DISCOVERY_REQUEST.length, t, port + 1));
                        } catch (IOException | SecurityException ignored) {
                        }
                    }
                    next++;
                }
                DatagramPacket p = new DatagramPacket(buf, buf.length);
                try {
                    s.receive(p);
                } catch (SocketTimeoutException e) {
                    continue;
                }
                Found f = parse(p);
                if (f != null && seen.add(f.id + "|" + f.address)) out.add(f);
            }
        } catch (IOException ignored) {
        } finally {
            if (s != null) s.close();
        }
        return out;
    }

    static Found parse(DatagramPacket p) {
        try {
            String text = new String(p.getData(), p.getOffset(), p.getLength(), StandardCharsets.UTF_8);
            if (!text.startsWith(Proto.DISCOVERY_REPLY)) return null;
            Map<String, Object> m = Json.parseObject(text.substring(Proto.DISCOVERY_REPLY.length()).trim());
            Found f = new Found();
            f.id = Json.getString(m, "id", "");
            f.name = Json.getString(m, "name", "PC");
            f.fingerprint = Json.getString(m, "fp", "");
            f.port = (int) Json.getLong(m, "port", Proto.DEFAULT_PORT);
            f.pairing = Json.getBool(m, "pairing", false);
            String ip = p.getAddress().getHostAddress();
            int pct = ip.indexOf('%');
            if (pct > 0) ip = ip.substring(0, pct);
            f.address = ip;
            return f;
        } catch (RuntimeException e) {
            return null;
        }
    }
}
