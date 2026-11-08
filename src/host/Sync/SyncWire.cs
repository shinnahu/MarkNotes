using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;

namespace MarkNotes.Sync;

/// <summary>Constants of the phone sync protocol (android/PROTOCOL.md).</summary>
internal static class Proto
{
    /// <summary>TCP port; UDP discovery uses the next one.</summary>
    public const int DefaultPort = 47830;
    /// <summary>Test profiles (--data-dir) listen elsewhere, so a test copy never takes the installed app's port.</summary>
    public const int TestPort = 47930;
    public const byte Version = 1;
    public static readonly byte[] Magic = "MNSY"u8.ToArray();
    public static readonly byte[] KeysInfo = "marknotes-sync-v1-keys"u8.ToArray();
    public static readonly byte[] SasLabel = "marknotes-sync-v1-sas"u8.ToArray();
    public static readonly byte[] DiscoveryRequest = "MARKNOTES?1"u8.ToArray();
    public static readonly byte[] DiscoveryReply = "MARKNOTES!1"u8.ToArray();
    public const int ClientHelloLen = 102, ServerHelloLen = 231, ServerHelloSignedLen = 167;
    public const int MaxRecord = 32 * 1024 * 1024 + 64;
    public const int Chunk = 1024 * 1024;

    public const byte Auth = 0x01, PairRequest = 0x02, PairReveal = 0x03;
    public const byte AuthResult = 0x80, PairChallenge = 0x81, PairResult = 0x82;
    public const byte Request = 0x10, DataUp = 0x11, EndUp = 0x12;
    public const byte Response = 0x90, DataDown = 0x91, EndDown = 0x92;
    public const byte Bye = 0x5F;

    public const byte StOk = 0, StUnknownDevice = 1, StBadToken = 2, StBusy = 3, StPairingClosed = 4, StDenied = 5,
        StRateLimited = 6, StVersion = 7, StTimeout = 8;

    /// <summary>
    /// Home network only: loopback, private and link-local IPv4, 100.64/10 (Tailscale), IPv6 loopback, link-local and
    /// unique-local (fc00::/7). IPv4-mapped IPv6 counts as its IPv4.
    /// </summary>
    public static bool IsLocal(IPAddress a)
    {
        if (a.IsIPv4MappedToIPv6) a = a.MapToIPv4();
        if (IPAddress.IsLoopback(a)) return true;
        var b = a.GetAddressBytes();
        if (a.AddressFamily == AddressFamily.InterNetwork)
        {
            return b[0] == 10 || (b[0] == 172 && (b[1] & 0xF0) == 16) || (b[0] == 192 && b[1] == 168) ||
                   (b[0] == 169 && b[1] == 254) || (b[0] == 100 && (b[1] & 0xC0) == 64);
        }
        if (a.AddressFamily == AddressFamily.InterNetworkV6)
            return a.IsIPv6LinkLocal || (b[0] & 0xFE) == 0xFC;
        return false;
    }

    public static string Hex(ReadOnlySpan<byte> b) => Convert.ToHexString(b).ToLowerInvariant();

    /// <summary>"AB12-CD34-EF56": the first 6 bytes of a fingerprint, for people to compare.</summary>
    public static string ShortFingerprint(string fp) =>
        fp.Length < 12 ? fp : $"{fp[..4]}-{fp[4..8]}-{fp[8..12]}".ToUpperInvariant();

    public static byte[] Cat(params byte[][] parts)
    {
        var o = new byte[parts.Sum(p => p.Length)];
        int i = 0;
        foreach (var p in parts) { p.CopyTo(o, i); i += p.Length; }
        return o;
    }
}

internal sealed class ByteWriter
{
    private readonly MemoryStream _ms = new();

    public ByteWriter U8(int v) { _ms.WriteByte((byte)v); return this; }

    public ByteWriter U16(int v) { Span<byte> b = stackalloc byte[2]; BinaryPrimitives.WriteUInt16BigEndian(b, (ushort)v); _ms.Write(b); return this; }

    public ByteWriter U32(uint v) { Span<byte> b = stackalloc byte[4]; BinaryPrimitives.WriteUInt32BigEndian(b, v); _ms.Write(b); return this; }

    public ByteWriter Bytes(ReadOnlySpan<byte> b) { _ms.Write(b); return this; }

    public ByteWriter Str(string? s)
    {
        var b = Encoding.UTF8.GetBytes(s ?? "");
        if (b.Length > 0xFFFF) b = b[..0xFFFF];
        U16(b.Length);
        _ms.Write(b);
        return this;
    }

    public byte[] ToArray() => _ms.ToArray();
}

internal sealed class ByteReader
{
    private readonly byte[] _b;
    private int _p;
    private readonly int _end;

    public ByteReader(byte[] b, int offset = 0) { _b = b; _p = offset; _end = b.Length; }

    public int Remaining => _end - _p;

    private void Need(int n) { if (_p + n > _end) throw new InvalidDataException("Message too short"); }

    public int U8() { Need(1); return _b[_p++]; }

    public int U16() { Need(2); int v = BinaryPrimitives.ReadUInt16BigEndian(_b.AsSpan(_p)); _p += 2; return v; }

    public byte[] Bytes(int n) { Need(n); var r = _b.AsSpan(_p, n).ToArray(); _p += n; return r; }

    public string Str() { int n = U16(); Need(n); var s = Encoding.UTF8.GetString(_b, _p, n); _p += n; return s; }

    public byte[] Tail() { var r = _b.AsSpan(_p, _end - _p).ToArray(); _p = _end; return r; }
}

/// <summary>
/// The PC's end of the encrypted channel (PROTOCOL.md §2–3): P-256 ECDH with a signed ServerHello, then AES-256-GCM
/// records. One reader and one writer may use it at the same time.
/// </summary>
internal sealed class SecureChannel : IDisposable
{
    private readonly Stream _s;
    private readonly AesGcm _enc;
    private readonly AesGcm _dec;
    private ulong _sendSeq, _recvSeq;
    private readonly SemaphoreSlim _sendGate = new(1, 1);

    public byte[] TranscriptHash { get; }

    private SecureChannel(Stream s, byte[] sendKey, byte[] recvKey, byte[] th)
    {
        _s = s;
        _enc = new AesGcm(sendKey, 16);
        _dec = new AesGcm(recvKey, 16);
        TranscriptHash = th;
    }

    public void Dispose()
    {
        _enc.Dispose();
        _dec.Dispose();
        try { _s.Dispose(); } catch { }
    }

    private static async Task<byte[]> ReadExactly(Stream s, int n, CancellationToken ct)
    {
        var b = new byte[n];
        await s.ReadExactlyAsync(b, ct);
        return b;
    }

    public static byte[] Point(ECParameters p)
    {
        var o = new byte[65];
        o[0] = 4;
        p.Q.X!.CopyTo(o, 1 + 32 - p.Q.X!.Length);
        p.Q.Y!.CopyTo(o, 33 + 32 - p.Q.Y!.Length);
        return o;
    }

    public static async Task<SecureChannel> AcceptAsync(Stream s, ECDsa identity, byte[] identityPub, CancellationToken ct)
    {
        var lenB = await ReadExactly(s, 4, ct);
        var len = BinaryPrimitives.ReadInt32BigEndian(lenB);
        if (len != Proto.ClientHelloLen) throw new InvalidDataException("Not a MarkNotes phone (hello length " + len + ")");
        var ch = await ReadExactly(s, len, ct);
        if (!ch.AsSpan(0, 4).SequenceEqual(Proto.Magic)) throw new InvalidDataException("Not a MarkNotes phone");
        if (ch[4] != Proto.Version) throw new InvalidDataException("Unsupported phone protocol version " + ch[4]);
        var clientEph = ch.AsSpan(5, 65).ToArray();
        if (clientEph[0] != 4) throw new InvalidDataException("Bad key");

        using var eph = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256);
        var ephPub = Point(eph.ExportParameters(false));
        var signedPart = new ByteWriter().Bytes(Proto.Magic).U8(Proto.Version).Bytes(ephPub)
            .Bytes(RandomNumberGenerator.GetBytes(32)).Bytes(identityPub).ToArray();
        var toSign = new byte[ch.Length + signedPart.Length];
        ch.CopyTo(toSign, 0);
        signedPart.CopyTo(toSign, ch.Length);
        var sig = identity.SignData(toSign, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        var sh = new byte[signedPart.Length + sig.Length];
        signedPart.CopyTo(sh, 0);
        sig.CopyTo(sh, signedPart.Length);
        if (sh.Length != Proto.ServerHelloLen) throw new InvalidOperationException("ServerHello length " + sh.Length);
        var frame = new byte[4 + sh.Length];
        BinaryPrimitives.WriteInt32BigEndian(frame, sh.Length);
        sh.CopyTo(frame, 4);
        await s.WriteAsync(frame, ct);
        await s.FlushAsync(ct);

        using var peer = ECDiffieHellman.Create(new ECParameters
        {
            Curve = ECCurve.NamedCurves.nistP256,
            Q = new ECPoint { X = clientEph.AsSpan(1, 32).ToArray(), Y = clientEph.AsSpan(33, 32).ToArray() },
        });
        var z = eph.DeriveRawSecretAgreement(peer.PublicKey);
        var th = SHA256.HashData(Proto.Cat(ch, sh));
        var prk = HMACSHA256.HashData(th, z);
        var k1 = HMACSHA256.HashData(prk, Proto.Cat(Proto.KeysInfo, new byte[] { 1 }));
        var k2 = HMACSHA256.HashData(prk, Proto.Cat(k1, Proto.KeysInfo, new byte[] { 2 }));
        // The phone sends with K1 and receives with K2.
        return new SecureChannel(s, k2, k1, th);
    }

    private static byte[] Nonce(ulong seq)
    {
        var n = new byte[12];
        BinaryPrimitives.WriteUInt64BigEndian(n.AsSpan(4), seq);
        return n;
    }

    public async Task SendAsync(byte[] plaintext, CancellationToken ct)
    {
        await _sendGate.WaitAsync(ct);
        try
        {
            int ctLen = plaintext.Length + 16;
            if (ctLen > Proto.MaxRecord) throw new InvalidOperationException("Record too large");
            var rec = new byte[4 + ctLen];
            BinaryPrimitives.WriteInt32BigEndian(rec, ctLen);
            _enc.Encrypt(Nonce(_sendSeq++), plaintext, rec.AsSpan(4, plaintext.Length), rec.AsSpan(4 + plaintext.Length, 16), rec.AsSpan(0, 4));
            await _s.WriteAsync(rec, ct);
            await _s.FlushAsync(ct);
        }
        finally { _sendGate.Release(); }
    }

    public Task SendAsync(byte type, ReadOnlySpan<byte> payload, CancellationToken ct)
    {
        var b = new byte[1 + payload.Length];
        b[0] = type;
        payload.CopyTo(b.AsSpan(1));
        return SendAsync(b, ct);
    }

    public async Task<byte[]> ReceiveAsync(CancellationToken ct)
    {
        var hdr = await ReadExactly(_s, 4, ct);
        int len = BinaryPrimitives.ReadInt32BigEndian(hdr);
        if (len < 17 || len > Proto.MaxRecord) throw new InvalidDataException("Bad record length " + len);
        var body = await ReadExactly(_s, len, ct);
        var pt = new byte[len - 16];
        _dec.Decrypt(Nonce(_recvSeq++), body.AsSpan(0, len - 16), body.AsSpan(len - 16), pt, hdr);
        if (pt.Length == 0) throw new InvalidDataException("Empty record");
        return pt;
    }
}
