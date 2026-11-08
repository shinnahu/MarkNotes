using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;

namespace MarkNotes.Sync;

/// <summary>
/// This PC's identity for phone sync: a P-256 key the phone pins when it pairs, and a random host id. The private key
/// is stored encrypted with DPAPI (only this Windows user can read it).
/// </summary>
internal sealed class SyncIdentity : IDisposable
{
    public ECDsa Key { get; }
    public byte[] PublicPoint { get; }
    public byte[] HostId { get; }
    public string Fingerprint { get; }

    private SyncIdentity(ECDsa key, byte[] hostId)
    {
        Key = key;
        HostId = hostId;
        PublicPoint = SecureChannel.Point(key.ExportParameters(false));
        Fingerprint = Proto.Hex(SHA256.HashData(PublicPoint));
    }

    public void Dispose() => Key.Dispose();

    private sealed class Stored
    {
        public string HostId { get; set; } = "";
        public string Key { get; set; } = "";
    }

    public static SyncIdentity LoadOrCreate(string dir)
    {
        var file = Path.Combine(dir, "identity.json");
        try
        {
            if (File.Exists(file))
            {
                var s = JsonSerializer.Deserialize<Stored>(File.ReadAllText(file), JsonOpts.Web);
                if (s != null && s.HostId.Length == 32 && s.Key.Length > 0)
                {
                    var key = ECDsa.Create();
                    key.ImportECPrivateKey(Dpapi.Unprotect(Convert.FromBase64String(s.Key)), out _);
                    return new SyncIdentity(key, Convert.FromHexString(s.HostId));
                }
            }
        }
        catch (Exception ex)
        {
            // A key that can't be read (another Windows user, a restored backup) means phones must pair again.
            Log.Error("SyncIdentity.Load", ex);
        }
        var fresh = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var id = new SyncIdentity(fresh, RandomNumberGenerator.GetBytes(16));
        var stored = new Stored { HostId = Proto.Hex(id.HostId), Key = Convert.ToBase64String(Dpapi.Protect(fresh.ExportECPrivateKey())) };
        HostSettings.WriteJsonFile(file, JsonSerializer.Serialize(stored, JsonOpts.Pretty));
        return id;
    }
}

/// <summary>CryptProtectData for the current user (no package needed).</summary>
internal static class Dpapi
{
    [StructLayout(LayoutKind.Sequential)]
    private struct Blob
    {
        public int Size;
        public IntPtr Data;
    }

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CryptProtectData(ref Blob dataIn, string? description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, ref Blob dataOut);

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CryptUnprotectData(ref Blob dataIn, IntPtr description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, ref Blob dataOut);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr mem);

    private const int UiForbidden = 0x1;

    private static byte[] Run(byte[] data, bool protect)
    {
        var input = new Blob { Size = data.Length, Data = Marshal.AllocHGlobal(Math.Max(1, data.Length)) };
        var output = new Blob();
        try
        {
            Marshal.Copy(data, 0, input.Data, data.Length);
            bool ok = protect
                ? CryptProtectData(ref input, "MarkNotes sync", IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, UiForbidden, ref output)
                : CryptUnprotectData(ref input, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, UiForbidden, ref output);
            if (!ok) throw new CryptographicException("DPAPI error " + Marshal.GetLastWin32Error());
            var result = new byte[output.Size];
            Marshal.Copy(output.Data, result, 0, output.Size);
            return result;
        }
        finally
        {
            Marshal.FreeHGlobal(input.Data);
            if (output.Data != IntPtr.Zero) LocalFree(output.Data);
        }
    }

    public static byte[] Protect(byte[] data) => Run(data, true);

    public static byte[] Unprotect(byte[] data) => Run(data, false);
}

/// <summary>A phone allowed to sync with this PC. Only the SHA-256 of its secret is kept.</summary>
public sealed class SyncDevice
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Model { get; set; } = "";
    public string TokenHash { get; set; } = "";
    public long PairedAt { get; set; }
    public long LastSeen { get; set; }
    public long LastSync { get; set; }
    public string? LastAddress { get; set; }
}

/// <summary>config\sync\devices.json</summary>
internal sealed class SyncDevices
{
    private readonly string _file;
    private readonly object _gate = new();
    private List<SyncDevice> _list;

    public SyncDevices(string dir)
    {
        _file = Path.Combine(dir, "devices.json");
        _list = Load();
    }

    private List<SyncDevice> Load()
    {
        try
        {
            if (File.Exists(_file)) return JsonSerializer.Deserialize<List<SyncDevice>>(File.ReadAllText(_file), JsonOpts.Web) ?? new();
        }
        catch (Exception ex) { Log.Error("SyncDevices.Load", ex); }
        return new();
    }

    private void Save() => HostSettings.WriteJsonFile(_file, JsonSerializer.Serialize(_list, JsonOpts.Pretty));

    public List<SyncDevice> All() { lock (_gate) return _list.Select(Copy).ToList(); }

    public int Count { get { lock (_gate) return _list.Count; } }

    private static SyncDevice Copy(SyncDevice d) => new()
    {
        Id = d.Id, Name = d.Name, Model = d.Model, TokenHash = d.TokenHash, PairedAt = d.PairedAt,
        LastSeen = d.LastSeen, LastSync = d.LastSync, LastAddress = d.LastAddress,
    };

    public SyncDevice Add(string name, string model, byte[] deviceId, byte[] token)
    {
        lock (_gate)
        {
            var d = new SyncDevice
            {
                Id = Proto.Hex(deviceId), Name = name, Model = model,
                TokenHash = Proto.Hex(SHA256.HashData(token)), PairedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            };
            _list.Add(d);
            Save();
            return Copy(d);
        }
    }

    /// <summary>0 = OK, else the AUTH status (unknown device, wrong secret).</summary>
    public byte Check(byte[] deviceId, byte[] token)
    {
        var id = Proto.Hex(deviceId);
        lock (_gate)
        {
            var d = _list.FirstOrDefault(x => x.Id == id);
            if (d == null) return Proto.StUnknownDevice;
            var want = Convert.FromHexString(d.TokenHash);
            return CryptographicOperations.FixedTimeEquals(want, SHA256.HashData(token)) ? Proto.StOk : Proto.StBadToken;
        }
    }

    public void Touch(string id, string? name, string? address, bool synced)
    {
        lock (_gate)
        {
            var d = _list.FirstOrDefault(x => x.Id == id);
            if (d == null) return;
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            d.LastSeen = now;
            if (synced) d.LastSync = now;
            if (!string.IsNullOrWhiteSpace(name)) d.Name = name;
            if (address != null) d.LastAddress = address;
            Save();
        }
    }

    public bool Remove(string id)
    {
        lock (_gate)
        {
            int n = _list.RemoveAll(x => x.Id == id);
            if (n > 0) Save();
            return n > 0;
        }
    }

    public SyncDevice? Find(string id) { lock (_gate) { var d = _list.FirstOrDefault(x => x.Id == id); return d == null ? null : Copy(d); } }
}
