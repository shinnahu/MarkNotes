package com.marknotes.core.sync;

import java.nio.charset.StandardCharsets;

/** Constants of the phone sync protocol (android/PROTOCOL.md). */
public final class Proto {
    private Proto() {}

    /** TCP port of MarkNotes on the PC; UDP discovery uses the next one. */
    public static final int DEFAULT_PORT = 47830;
    public static final int VERSION = 1;

    static final byte[] MAGIC = "MNSY".getBytes(StandardCharsets.US_ASCII);
    static final byte[] KEYS_INFO = "marknotes-sync-v1-keys".getBytes(StandardCharsets.US_ASCII);
    static final byte[] SAS_LABEL = "marknotes-sync-v1-sas".getBytes(StandardCharsets.US_ASCII);
    static final byte[] DISCOVERY_REQUEST = "MARKNOTES?1".getBytes(StandardCharsets.US_ASCII);
    static final String DISCOVERY_REPLY = "MARKNOTES!1";

    static final int CLIENT_HELLO_LEN = 102;
    static final int SERVER_HELLO_LEN = 231;
    static final int SERVER_HELLO_SIGNED_LEN = 167;
    static final int MAX_RECORD = 32 * 1024 * 1024 + 64;
    static final int CHUNK = 1024 * 1024;

    static final int AUTH = 0x01, PAIR_REQUEST = 0x02, PAIR_REVEAL = 0x03;
    static final int AUTH_RESULT = 0x80, PAIR_CHALLENGE = 0x81, PAIR_RESULT = 0x82;
    static final int REQUEST = 0x10, DATA_UP = 0x11, END_UP = 0x12;
    static final int RESPONSE = 0x90, DATA_DOWN = 0x91, END_DOWN = 0x92;
    static final int BYE = 0x5F;

    public static final int ST_OK = 0, ST_UNKNOWN_DEVICE = 1, ST_BAD_TOKEN = 2, ST_BUSY = 3, ST_PAIRING_CLOSED = 4,
            ST_DENIED = 5, ST_RATE_LIMITED = 6, ST_VERSION = 7, ST_TIMEOUT = 8;
}
