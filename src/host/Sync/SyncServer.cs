using System.Collections.Concurrent;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using MarkNotes.Storage;

namespace MarkNotes.Sync;

/// <summary>
/// MarkNotes' side of phone sync: answers phones on the home network (TCP 47830, discovery on UDP 47831), pairs new
/// phones after the user allows them on this PC, and serves the workspaces' files to paired ones. The phone runs the
/// sync; this side only lists, sends and stores files (android/PROTOCOL.md).
/// </summary>
public sealed class SyncServer : IDisposable
{
    private readonly Func<NoteStore> _store;
    private readonly Action<string, object?> _emit;
    private readonly Action _bringToFront;
    private readonly string _dir;
    private readonly SyncFiles _files;
    private SyncIdentity? _identity;
    private SyncDevices? _devices;
    private readonly object _gate = new();

    private CancellationTokenSource? _cts;
    private TcpListener? _tcp;
    private UdpClient? _udp;
    private string? _error;
    private bool _enabled;
    private DateTime _pairingUntil = DateTime.MinValue;
    private string? _activeDevice;
    private readonly ConcurrentDictionary<string, TaskCompletionSource<bool>> _pairAsks = new();
    private readonly ConcurrentDictionary<string, (int Count, DateTime Since)> _failures = new();

    public int Port { get; }

    /// <summary>False: listen on this PC only (127.0.0.1), as test profiles do, so tests never open the network or
    /// make Windows Firewall ask.</summary>
    private readonly bool _lan;

    public SyncServer(Func<NoteStore> store, Action<string, object?> emit, Action bringToFront, int port, bool lan = true)
    {
        _lan = lan;
        _store = store;
        _emit = emit;
        _bringToFront = bringToFront;
        Port = port;
        _dir = Path.Combine(AppPaths.ConfigDir, "sync");
        _files = new SyncFiles(store, AppPaths.LocalDir);
    }

    private SyncIdentity Identity { get { lock (_gate) return _identity ??= SyncIdentity.LoadOrCreate(_dir); } }

    private SyncDevices Devices { get { lock (_gate) return _devices ??= new SyncDevices(_dir); } }

    public void Dispose()
    {
        Stop();
        _identity?.Dispose();
    }

    // ─────────────────────────── on / off ───────────────────────────

    public bool Enabled => _enabled;

    public void SetEnabled(bool on)
    {
        if (on) Start();
        else Stop();
        EmitState();
    }

    private void Start()
    {
        lock (_gate)
        {
            _enabled = true;
            if (_cts != null) return;
            _error = null;
            var cts = new CancellationTokenSource();
            try
            {
                var tcp = _lan ? new TcpListener(IPAddress.IPv6Any, Port) : new TcpListener(IPAddress.Loopback, Port);
                if (_lan) tcp.Server.DualMode = true;
                tcp.Server.ExclusiveAddressUse = true;
                tcp.Start(16);
                _tcp = tcp;
                try
                {
                    var udp = new UdpClient(AddressFamily.InterNetwork);
                    udp.Client.ExclusiveAddressUse = true;
                    udp.Client.Bind(new IPEndPoint(_lan ? IPAddress.Any : IPAddress.Loopback, Port + 1));
                    udp.EnableBroadcast = true;
                    _udp = udp;
                }
                catch (Exception ex)
                {
                    // Without discovery the phone can still connect by address.
                    Log.Error("Sync UDP", ex);
                }
                _cts = cts;
                _ = Task.Run(() => AcceptLoop(tcp, cts.Token));
                if (_udp != null) _ = Task.Run(() => DiscoveryLoop(_udp, cts.Token));
                _ = Task.Run(() => Identity); // make the key now, not while a phone waits
                Log.Info($"Phone sync listening on TCP {Port}, UDP {Port + 1}");
            }
            catch (Exception ex)
            {
                Log.Error("Sync start", ex);
                _error = ex is SocketException { SocketErrorCode: SocketError.AddressAlreadyInUse }
                    ? UiLang.T($"Port {Port} is in use by another program.", $"Otro programa está usando el puerto {Port}.")
                    : ex.Message;
                try { _tcp?.Stop(); } catch { }
                _tcp = null;
                cts.Dispose();
            }
        }
    }

    private void Stop()
    {
        lock (_gate)
        {
            _enabled = false;
            _cts?.Cancel();
            _cts?.Dispose();
            _cts = null;
            try { _tcp?.Stop(); } catch { }
            try { _udp?.Dispose(); } catch { }
            _tcp = null;
            _udp = null;
            _pairingUntil = DateTime.MinValue;
        }
        foreach (var t in _pairAsks.Values) t.TrySetResult(false);
    }

    // ─────────────────────────── pairing window ───────────────────────────

    public bool PairingOpen => DateTime.UtcNow < _pairingUntil && _cts != null;

    /// <summary>Open while the Pair a phone panel is on screen (10 minutes at most).</summary>
    public void SetPairing(bool on)
    {
        _pairingUntil = on ? DateTime.UtcNow.AddMinutes(10) : DateTime.MinValue;
        if (!on) foreach (var t in _pairAsks.Values) t.TrySetResult(false);
        EmitState();
    }

    public void AnswerPair(string id, bool allow)
    {
        if (_pairAsks.TryGetValue(id, out var t)) t.TrySetResult(allow);
    }

    public bool Unlink(string deviceId)
    {
        var ok = Devices.Remove(deviceId);
        EmitState();
        return ok;
    }

    // ─────────────────────────── status ───────────────────────────

    private static List<string> LanAddresses()
    {
        var list = new List<string>();
        try
        {
            foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (ni.OperationalStatus != OperationalStatus.Up || ni.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
                var desc = (ni.Description + " " + ni.Name).ToLowerInvariant();
                if (desc.Contains("virtual") || desc.Contains("hyper-v") || desc.Contains("vmware") || desc.Contains("vethernet") || desc.Contains("wsl")) continue;
                foreach (var ua in ni.GetIPProperties().UnicastAddresses)
                {
                    var a = ua.Address;
                    if (a.AddressFamily == AddressFamily.InterNetwork && Proto.IsLocal(a) && !IPAddress.IsLoopback(a)) list.Add(a.ToString());
                }
            }
        }
        catch (Exception ex) { Log.Error("LanAddresses", ex); }
        return list.Distinct().ToList();
    }

    public object Status() => new
    {
        enabled = _enabled,
        running = _cts != null,
        error = _error,
        port = Port,
        hostName = Environment.MachineName,
        fingerprint = _cts != null ? Proto.ShortFingerprint(Identity.Fingerprint) : null,
        addresses = LanAddresses(),
        pairing = PairingOpen,
        active = _activeDevice,
        devices = Devices.All().Select(d => new { id = d.Id, name = d.Name, model = d.Model, pairedAt = d.PairedAt, lastSeen = d.LastSeen, lastSync = d.LastSync, history = _files.HistoryBytes(d.Id) }).ToList(),
        orphanHistory = _files.OrphanBytes(Devices.All().Select(d => d.Id)),
    };

    /// <summary>Settings › Phone › Delete old versions: those kept for one phone, or ("orphans") for unlinked ones.</summary>
    public void ClearHistory(string device)
    {
        _files.ClearHistory(device, Devices.All().Select(d => d.Id));
        EmitState();
    }

    private void EmitState()
    {
        try { _emit("sync.state", Status()); } catch (Exception ex) { Log.Error("sync.state", ex); }
    }

    // ─────────────────────────── discovery ───────────────────────────

    private async Task DiscoveryLoop(UdpClient udp, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            UdpReceiveResult r;
            try { r = await udp.ReceiveAsync(ct); }
            catch (OperationCanceledException) { return; }
            catch (ObjectDisposedException) { return; }
            catch (SocketException) { continue; }
            try
            {
                if (!r.Buffer.AsSpan().SequenceEqual(Proto.DiscoveryRequest) || !Proto.IsLocal(r.RemoteEndPoint.Address)) continue;
                var json = JsonSerializer.Serialize(new
                {
                    id = Proto.Hex(Identity.HostId), name = Environment.MachineName, port = Port, fp = Identity.Fingerprint,
                    pairing = PairingOpen, ver = (int)Proto.Version,
                });
                var reply = Proto.DiscoveryReply.Concat(Encoding.UTF8.GetBytes(json)).ToArray();
                await udp.SendAsync(reply, r.RemoteEndPoint, ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException) { Log.Info("Sync discovery: " + ex.Message); }
        }
    }

    // ─────────────────────────── connections ───────────────────────────

    private async Task AcceptLoop(TcpListener tcp, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            TcpClient client;
            try { client = await tcp.AcceptTcpClientAsync(ct); }
            catch (OperationCanceledException) { return; }
            catch (ObjectDisposedException) { return; }
            catch (SocketException ex) { Log.Info("Sync accept: " + ex.Message); continue; }
            _ = Task.Run(() => Serve(client, ct));
        }
    }

    private bool Blocked(IPAddress ip)
    {
        var k = ip.ToString();
        if (!_failures.TryGetValue(k, out var f)) return false;
        if (DateTime.UtcNow - f.Since > TimeSpan.FromMinutes(10)) { _failures.TryRemove(k, out _); return false; }
        return f.Count >= 10;
    }

    private void Failed(IPAddress ip)
    {
        var k = ip.ToString();
        _failures.AddOrUpdate(k, (1, DateTime.UtcNow), (_, f) => DateTime.UtcNow - f.Since > TimeSpan.FromMinutes(10) ? (1, DateTime.UtcNow) : (f.Count + 1, f.Since));
    }

    private static CancellationToken Timeout(CancellationToken outer, int ms, out CancellationTokenSource cts)
    {
        cts = CancellationTokenSource.CreateLinkedTokenSource(outer);
        cts.CancelAfter(ms);
        return cts.Token;
    }

    private async Task<byte[]> Receive(SecureChannel ch, CancellationToken outer, int ms = 60_000)
    {
        var t = Timeout(outer, ms, out var cts);
        using (cts) return await ch.ReceiveAsync(t);
    }

    private async Task Send(SecureChannel ch, byte type, byte[] payload, CancellationToken outer)
    {
        var t = Timeout(outer, 60_000, out var cts);
        using (cts) await ch.SendAsync(type, payload, t);
    }

    private async Task Serve(TcpClient client, CancellationToken ct)
    {
        var remote = (client.Client.RemoteEndPoint as IPEndPoint)?.Address ?? IPAddress.None;
        if (remote.IsIPv4MappedToIPv6) remote = remote.MapToIPv4();
        using var _c = client;
        if (!Proto.IsLocal(remote) || Blocked(remote)) return;
        client.NoDelay = true;
        SecureChannel? ch = null;
        string? deviceId = null;
        var changed = new HashSet<string>();
        try
        {
            var hs = Timeout(ct, 10_000, out var hsCts);
            using (hsCts) ch = await SecureChannel.AcceptAsync(client.GetStream(), Identity.Key, Identity.PublicPoint, hs);

            var first = await Receive(ch, ct, 15_000);
            if (first[0] == Proto.PairRequest)
            {
                var paired = await Pair(ch, first, remote, ct);
                if (paired == null) return;
                first = await Receive(ch, ct, 15_000);
            }
            if (first[0] != Proto.Auth) { Failed(remote); return; }
            var r = new ByteReader(first, 1);
            var devId = r.Bytes(16);
            var token = r.Bytes(32);
            var name = r.Str();
            byte st = Devices.Check(devId, token);
            if (st != Proto.StOk)
            {
                Failed(remote);
                await Send(ch, Proto.AuthResult, new ByteWriter().U8(st).Str(st == Proto.StUnknownDevice
                    ? UiLang.T("This phone is no longer linked to this PC. Pair it again.", "Este teléfono ya no está vinculado a esta PC. Vinculalo de nuevo.")
                    : UiLang.T("The phone's key was refused.", "Se rechazó la clave del teléfono.")).ToArray(), ct);
                return;
            }
            deviceId = Proto.Hex(devId);
            lock (_gate)
            {
                if (_activeDevice != null && _activeDevice != deviceId) st = Proto.StBusy;
                else _activeDevice = deviceId;
            }
            if (st == Proto.StBusy)
            {
                deviceId = null;
                await Send(ch, Proto.AuthResult, new ByteWriter().U8(Proto.StBusy).Str(UiLang.T("Another phone is syncing with this PC.", "Otro teléfono se está sincronizando con esta PC.")).ToArray(), ct);
                return;
            }
            Devices.Touch(deviceId, name, remote.ToString(), false);
            await Send(ch, Proto.AuthResult, new ByteWriter().U8(Proto.StOk).Str("").ToArray(), ct);
            EmitState();
            await RequestLoop(ch, deviceId, changed, ct);
            Devices.Touch(deviceId, null, null, true);
        }
        catch (Exception ex) when (ex is OperationCanceledException or IOException or EndOfStreamException or SocketException)
        {
            Log.Info($"Sync connection from {remote} ended: {ex.Message}");
        }
        catch (Exception ex)
        {
            Log.Error("Sync connection " + remote, ex);
        }
        finally
        {
            ch?.Dispose();
            if (deviceId != null)
            {
                lock (_gate) if (_activeDevice == deviceId) _activeDevice = null;
            }
            if (changed.Count > 0) AfterChanges(changed);
            if (deviceId != null) EmitState();
        }
    }

    private void AfterChanges(HashSet<string> changed)
    {
        try { _store().SyncReload(changed); } catch (Exception ex) { Log.Error("SyncReload", ex); }
        _emit("sync.changed", new { workspaces = changed.ToList() });
    }

    // ─────────────────────────── pairing ───────────────────────────

    private async Task<SyncDevice?> Pair(SecureChannel ch, byte[] req, IPAddress remote, CancellationToken ct)
    {
        var r = new ByteReader(req, 1);
        var commit = r.Bytes(32);
        var name = r.Str();
        var model = r.Str();
        if (!PairingOpen)
        {
            await Send(ch, Proto.PairResult, new ByteWriter().U8(Proto.StPairingClosed)
                .Str(UiLang.T("On the PC, open MarkNotes › Settings › Phone and click Pair a phone.", "En la PC, abrí MarkNotes › Configuración › Teléfono y hacé clic en Vincular un teléfono.")).ToArray(), ct);
            return null;
        }
        var nonceH = RandomNumberGenerator.GetBytes(32);
        await Send(ch, Proto.PairChallenge, nonceH, ct);
        var reveal = await Receive(ch, ct, 20_000);
        if (reveal[0] != Proto.PairReveal) return null;
        var nonceC = new ByteReader(reveal, 1).Bytes(32);
        if (!CryptographicOperations.FixedTimeEquals(SHA256.HashData(nonceC), commit))
        {
            Failed(remote);
            return null;
        }
        var d = SHA256.HashData(Proto.Cat(Proto.SasLabel, ch.TranscriptHash, nonceC, nonceH));
        uint v = ((uint)d[0] << 24) | ((uint)d[1] << 16) | ((uint)d[2] << 8) | d[3];
        var digits = (v % 1_000_000).ToString("D6");
        var code = digits[..3] + " " + digits[3..];

        var askId = Proto.Hex(RandomNumberGenerator.GetBytes(6));
        var tcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        _pairAsks[askId] = tcs;
        bool allow;
        try
        {
            _bringToFront();
            _emit("sync.pairRequest", new { id = askId, device = name, model, code });
            var done = await Task.WhenAny(tcs.Task, Task.Delay(120_000, ct));
            allow = done == tcs.Task && tcs.Task.Result;
            if (done != tcs.Task) _emit("sync.pairDone", new { id = askId, result = "timeout" });
        }
        finally { _pairAsks.TryRemove(askId, out _); }

        if (!allow)
        {
            await Send(ch, Proto.PairResult, new ByteWriter().U8(Proto.StDenied)
                .Str(UiLang.T("The PC didn't allow this phone.", "La PC no permitió este teléfono.")).ToArray(), ct);
            return null;
        }
        var devId = RandomNumberGenerator.GetBytes(16);
        var token = RandomNumberGenerator.GetBytes(32);
        var dev = Devices.Add(name, model, devId, token);
        await Send(ch, Proto.PairResult, new ByteWriter().U8(Proto.StOk).Bytes(devId).Bytes(token).Bytes(Identity.HostId)
            .Str(Environment.MachineName).Str("").ToArray(), ct);
        _emit("sync.pairDone", new { id = askId, result = "paired", device = name });
        EmitState();
        return dev;
    }

    // ─────────────────────────── requests ───────────────────────────

    private static byte[] JsonBytes(object o) => JsonSerializer.SerializeToUtf8Bytes(o, JsonOpts.Web);

    private async Task Respond(SecureChannel ch, object o, CancellationToken ct) => await Send(ch, Proto.Response, JsonBytes(o), ct);

    private async Task RequestLoop(SecureChannel ch, string device, HashSet<string> changed, CancellationToken ct)
    {
        while (true)
        {
            var m = await Receive(ch, ct, 120_000);
            if (m[0] == Proto.Bye) return;
            if (m[0] != Proto.Request) throw new InvalidDataException("Unexpected message " + m[0]);
            JsonObject req;
            try { req = JsonNode.Parse(m.AsSpan(1))?.AsObject() ?? throw new InvalidDataException("Empty request"); }
            catch (JsonException) { throw new InvalidDataException("Bad request"); }
            var op = (string?)req["op"] ?? "";
            try
            {
                switch (op)
                {
                    case "info": await Respond(ch, Info(), ct); break;
                    case "manifest":
                    {
                        var ws = Ws(req);
                        var entries = await Task.Run(() => _files.Manifest(ws), ct);
                        await Respond(ch, new { ok = true, entries }, ct);
                        break;
                    }
                    case "get": await Get(ch, req, ct); break;
                    case "put": await Put(ch, req, device, changed, ct); break;
                    case "delete":
                        _files.Delete(Ws(req), (string?)req["p"] ?? "", (string?)req["base"], device, (string?)req["run"]);
                        changed.Add(Ws(req));
                        await Respond(ch, new { ok = true }, ct);
                        break;
                    case "restore":
                    {
                        // Undo of a sync run: the PC's version from before that run comes back (PROTOCOL.md §7).
                        var ws = Ws(req);
                        var (rel, h) = await Task.Run(() => _files.Restore(device, (string?)req["run"] ?? "", ws, (string?)req["p"] ?? "",
                            (string?)req["expect"], (string?)req["undo"]), ct);
                        changed.Add(ws);
                        await Respond(ch, new { ok = true, p = rel, h }, ct);
                        break;
                    }
                    case "forget":
                        if (req["runs"] is JsonArray runs) _files.ForgetRuns(device, runs.Select(x => (string?)x ?? "").ToList());
                        await Respond(ch, new { ok = true }, ct);
                        break;
                    case "mkdir":
                        _files.Mkdir(Ws(req), (string?)req["p"] ?? "");
                        changed.Add(Ws(req));
                        await Respond(ch, new { ok = true }, ct);
                        break;
                    case "rmdir":
                        _files.Rmdir(Ws(req), (string?)req["p"] ?? "");
                        changed.Add(Ws(req));
                        await Respond(ch, new { ok = true }, ct);
                        break;
                    case "createWs":
                    {
                        var id = (string?)req["ws"] ?? throw new SyncError("bad", "Missing ws");
                        if (!System.Text.RegularExpressions.Regex.IsMatch(id, "^[A-Za-z0-9_-]{1,64}$")) throw new SyncError("bad", "Bad workspace id");
                        var meta = Convert.FromBase64String((string?)req["meta"] ?? "");
                        var dir = _store().SyncAdoptWorkspace(id, (string?)req["dir"] ?? "", meta);
                        changed.Add(id);
                        await Respond(ch, new { ok = true, dir = Path.GetFileName(dir) }, ct);
                        break;
                    }
                    case "done":
                        if (req["changed"] is JsonArray arr) foreach (var x in arr) if ((string?)x is { } s) changed.Add(s);
                        if (changed.Count > 0) { AfterChanges(changed); changed.Clear(); }
                        await Respond(ch, new { ok = true }, ct);
                        break;
                    default: throw new SyncError("bad", "Unknown request " + op);
                }
            }
            catch (SyncError e) { await Respond(ch, new { ok = false, code = e.Code, error = e.Message }, ct); }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException or InvalidOperationException or InvalidDataException or JsonException or FormatException)
            {
                Log.Error("Sync " + op, e);
                await Respond(ch, new { ok = false, code = e is IOException ? "busy" : "error", error = e.Message }, ct);
            }
        }
    }

    private string Ws(JsonObject req)
    {
        var id = (string?)req["ws"] ?? throw new SyncError("bad", "Missing ws");
        try { _store().SyncDir(id); }
        catch (InvalidOperationException) { throw new SyncError("noWorkspace", "This workspace isn't on the PC"); }
        return id;
    }

    private object Info()
    {
        var list = _store().SyncWorkspaces().Select(w => new
        {
            id = w.Id, name = w.Name, dir = Path.GetFileName(w.Dir), color = w.Color, linked = w.Linked, notes = w.Notes,
        }).ToList();
        return new
        {
            ok = true,
            host = new { id = Proto.Hex(Identity.HostId), name = Environment.MachineName, ver = (int)Proto.Version },
            // "history": keeps the PC's old versions per sync run and answers restore/forget (MarkNotes 2.5.1).
            features = new[] { "history" },
            addresses = LanAddresses(),
            workspaces = list,
        };
    }

    private async Task Get(SecureChannel ch, JsonObject req, CancellationToken ct)
    {
        var f = _files.Open(Ws(req), (string?)req["p"] ?? "");
        if (f == null) throw new SyncError("missing", "Not on the PC any more");
        await using var data = f.Value.Data;
        await Respond(ch, new { ok = true, s = f.Value.Size, m = f.Value.Mtime, h = f.Value.Hash }, ct);
        var buf = new byte[Proto.Chunk];
        long left = f.Value.Size;
        while (left > 0)
        {
            int n = await data.ReadAsync(buf.AsMemory(0, (int)Math.Min(buf.Length, left)), ct);
            if (n <= 0) break;
            await Send(ch, Proto.DataDown, buf.AsSpan(0, n).ToArray(), ct);
            left -= n;
        }
        await Send(ch, Proto.EndDown, Array.Empty<byte>(), ct);
    }

    private async Task Put(SecureChannel ch, JsonObject req, string device, HashSet<string> changed, CancellationToken ct)
    {
        // The bytes always follow the request: read them all, even when the file can't be taken, to stay in step.
        string? tmp = null;
        SyncError? refused = null;
        string ws = "", rel = (string?)req["p"] ?? "";
        long size = (long?)req["s"] ?? -1, mtime = (long?)req["m"] ?? 0;
        var hash = (string?)req["h"] ?? "";
        var baseHash = (string?)req["base"];
        FileStream? fs = null;
        try
        {
            try
            {
                ws = Ws(req);
                tmp = _files.TempFor(ws, rel);
                fs = new FileStream(tmp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1 << 16);
            }
            catch (SyncError e) { refused = e; }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { refused = new SyncError("busy", e.Message); }
            using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            long got = 0;
            while (true)
            {
                var m = await Receive(ch, ct);
                if (m[0] == Proto.EndUp) break;
                if (m[0] != Proto.DataUp) throw new InvalidDataException("Expected file data");
                got += m.Length - 1;
                if (refused == null && fs != null)
                {
                    if (got > size) refused = new SyncError("corrupt", "More bytes than announced");
                    else
                    {
                        sha.AppendData(m, 1, m.Length - 1);
                        await fs.WriteAsync(m.AsMemory(1), ct);
                    }
                }
            }
            if (fs != null) { await fs.DisposeAsync(); fs = null; }
            if (refused != null) throw refused;
            if (got != size || Proto.Hex(sha.GetHashAndReset()) != hash) throw new SyncError("corrupt", "The file arrived damaged");
            var run = (string?)req["run"];
            var shown = await Task.Run(() => _files.Commit(ws, rel, tmp!, mtime, hash, baseHash, device, run), ct);
            tmp = null;
            changed.Add(ws);
            await Respond(ch, new { ok = true, h = shown }, ct);
        }
        finally
        {
            if (fs != null) await fs.DisposeAsync();
            if (tmp != null) { try { File.Delete(tmp); } catch { } }
        }
    }
}
