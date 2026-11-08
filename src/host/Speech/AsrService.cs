using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Channels;
using NAudio.CoreAudioApi;
using NAudio.Dsp;
using NAudio.Wave;
using Whisper.net;
using Whisper.net.LibraryLoader;

namespace MarkNotes.Speech;

public sealed record AsrModel(string Id, string File, int SizeMb, string Label, string Hint);

public sealed class AsrStartOptions
{
    public string ModelId { get; set; } = "large-v3-turbo-q5_0";
    public string Language { get; set; } = "auto";
    public bool UseGpu { get; set; } = true;
    public bool Mic { get; set; } = true;
    public bool Desktop { get; set; } = true;
    public string? MicDevice { get; set; }
    public string? DesktopDevice { get; set; }
    public string? Prompt { get; set; }
    public int Threads { get; set; }
}

/// <summary>
/// Offline speech-to-text: records the microphone and/or what the PC is playing (WASAPI
/// loopback), cuts the audio at pauses and runs whisper.cpp on it - on the GPU through
/// Vulkan when available, otherwise on the CPU. Nothing leaves the computer; the only
/// network access is the one-time model download the user starts in Settings.
/// </summary>
public sealed class AsrService : IDisposable
{
    public static readonly AsrModel[] Catalog =
    {
        new("tiny", "ggml-tiny.bin", 75, "Tiny", "Fastest, least accurate. Good for testing."),
        new("base", "ggml-base.bin", 142, "Base", "Fast, OK accuracy."),
        new("small", "ggml-small.bin", 466, "Small", "Good balance, fine on CPU."),
        new("large-v3-turbo-q5_0", "ggml-large-v3-turbo-q5_0.bin", 547, "Large v3 Turbo (compact)", "Recommended with a GPU: best Spanish/English quality, light on VRAM (~1 GB)."),
        new("medium", "ggml-medium.bin", 1463, "Medium", "Accurate, slower."),
        new("large-v3-turbo", "ggml-large-v3-turbo.bin", 1549, "Large v3 Turbo (full)", "Same as compact but bigger; tiny accuracy gain."),
    };

    private const string ModelBaseUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";

    private readonly Action<string, object?> _emit;
    private readonly Dictionary<string, CancellationTokenSource> _downloads = new();
    private readonly object _gate = new();

    private WhisperFactory? _factory;
    private WhisperProcessor? _processor;
    private readonly List<AudioSource> _sources = new();
    private Channel<AudioChunk>? _queue;
    private Task? _worker;
    private CancellationTokenSource? _cts;
    private System.Threading.Timer? _levelTimer;
    private bool _libraryChosen;
    private int _pending;
    private bool _auto;
    private string _lang = "es";
    private readonly Dictionary<string, string> _langBySource = new();

    public bool Running { get; private set; }
    public string? Backend { get; private set; }

    public AsrService(Action<string, object?> emit) => _emit = emit;

    private static string ModelPath(AsrModel m) => Path.Combine(AppPaths.ModelsDir, m.File);

    /// <summary>Cheap check for the UI at startup: are the speech engine files installed, and how many models are downloaded.</summary>
    public static object Availability()
    {
        bool engine = File.Exists(Path.Combine(AppPaths.ExeDir, "runtimes", "win-x64", "whisper.dll"))
            || File.Exists(Path.Combine(AppPaths.ExeDir, "runtimes", "vulkan", "win-x64", "whisper.dll"));
        int models = 0;
        try { foreach (var m in Catalog) if (File.Exists(ModelPath(m))) models++; } catch { }
        return new { engine, models };
    }

    public static AsrModel FindModel(string id) =>
        Catalog.FirstOrDefault(m => m.Id == id) ?? throw new ArgumentException("Unknown model " + id);

    public object Status()
    {
        var models = Catalog.Select(m => new
        {
            id = m.Id,
            label = m.Label,
            hint = m.Hint,
            sizeMb = m.SizeMb,
            installed = File.Exists(ModelPath(m)),
            downloading = _downloads.ContainsKey(m.Id),
        }).ToList();
        object devices;
        try
        {
            using var en = new MMDeviceEnumerator();
            devices = new
            {
                mic = en.EnumerateAudioEndPoints(DataFlow.Capture, DeviceState.Active).Select(d => new { id = d.ID, name = d.FriendlyName }).ToList(),
                desktop = en.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active).Select(d => new { id = d.ID, name = d.FriendlyName }).ToList(),
            };
        }
        catch (Exception ex)
        {
            Log.Error("Asr.Devices", ex);
            devices = new { mic = Array.Empty<object>(), desktop = Array.Empty<object>() };
        }
        return new { models, devices, running = Running, backend = Backend, modelsDir = AppPaths.ModelsDir };
    }

    // ───────────────────────────── model files ─────────────────────────────

    public void StartDownload(string id)
    {
        var m = FindModel(id);
        CancellationTokenSource cts;
        lock (_gate)
        {
            if (_downloads.ContainsKey(id)) return;
            cts = new CancellationTokenSource();
            _downloads[id] = cts;
        }
        _ = Task.Run(async () =>
        {
            var dest = ModelPath(m);
            var part = dest + ".part";
            try
            {
                Directory.CreateDirectory(AppPaths.ModelsDir);
                using var http = new HttpClient { Timeout = Timeout.InfiniteTimeSpan };
                http.DefaultRequestHeaders.UserAgent.ParseAdd("MarkNotes/2.0");
                using var resp = await http.GetAsync(ModelBaseUrl + m.File, HttpCompletionOption.ResponseHeadersRead, cts.Token);
                resp.EnsureSuccessStatusCode();
                var total = resp.Content.Headers.ContentLength ?? (long)m.SizeMb * 1024 * 1024;
                await using (var src = await resp.Content.ReadAsStreamAsync(cts.Token))
                await using (var fs = new FileStream(part, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 20, true))
                {
                    var buf = new byte[1 << 20];
                    long got = 0;
                    var sw = Stopwatch.StartNew();
                    long lastEmit = -1000;
                    int n;
                    while ((n = await src.ReadAsync(buf, cts.Token)) > 0)
                    {
                        await fs.WriteAsync(buf.AsMemory(0, n), cts.Token);
                        got += n;
                        if (sw.ElapsedMilliseconds - lastEmit > 300)
                        {
                            lastEmit = sw.ElapsedMilliseconds;
                            _emit("asr.download", new { id, received = got, total, done = false });
                        }
                    }
                }
                File.Move(part, dest, true);
                _emit("asr.download", new { id, received = new FileInfo(dest).Length, total = new FileInfo(dest).Length, done = true });
            }
            catch (Exception ex)
            {
                try { if (File.Exists(part)) File.Delete(part); } catch { }
                var cancelled = ex is OperationCanceledException;
                if (!cancelled) Log.Error("Asr.Download", ex);
                _emit("asr.download", new { id, done = true, error = cancelled ? "cancelled" : ex.Message });
            }
            finally
            {
                lock (_gate) _downloads.Remove(id);
            }
        });
    }

    public void CancelDownload(string id)
    {
        lock (_gate)
            if (_downloads.TryGetValue(id, out var cts)) cts.Cancel();
    }

    public void DeleteModel(string id)
    {
        var p = ModelPath(FindModel(id));
        if (File.Exists(p)) File.Delete(p);
    }

    public void ImportModel(string id, string file)
    {
        var m = FindModel(id);
        Directory.CreateDirectory(AppPaths.ModelsDir);
        File.Copy(file, ModelPath(m), true);
    }

    // ───────────────────────────── audio files ─────────────────────────────

    private void ChooseLibrary(bool useGpu)
    {
        if (_libraryChosen) return;
        // The native library can only be chosen once per process.
        RuntimeOptions.RuntimeLibraryOrder = useGpu
            ? new List<RuntimeLibrary> { RuntimeLibrary.Vulkan, RuntimeLibrary.Cpu, RuntimeLibrary.CpuNoAvx }
            : new List<RuntimeLibrary> { RuntimeLibrary.Cpu, RuntimeLibrary.CpuNoAvx };
        _libraryChosen = true;
    }

    /// <summary>What "Auto" chooses between. Other languages are picked by hand in Settings.</summary>
    private static readonly string[] AutoLanguages = { "es", "en" };

    private static bool IsAuto(AsrStartOptions o) => string.IsNullOrWhiteSpace(o.Language) || o.Language == "auto";

    private static WhisperProcessorBuilder Configure(WhisperProcessorBuilder b, AsrStartOptions o, bool live)
    {
        var threads = o.Threads > 0 ? o.Threads : Math.Clamp(Environment.ProcessorCount / 2, 2, 8);
        b = b.WithThreads(threads).WithNoSpeechThreshold(0.6f).WithTemperature(0f).WithProbabilities();
        // "Auto" starts in Spanish and switches between Spanish and English (PickLanguage): detecting among
        // every language made short or noisy phrases come out in Japanese, Russian…
        b = b.WithLanguage(IsAuto(o) ? "es" : o.Language);
        // Live: each phrase on its own, so one wrong phrase (or the other speaker's) doesn't steer the next.
        if (live) b = b.WithNoContext();
        var prompt = VocabularyPrompt(o.Prompt);
        if (prompt != null) b = b.WithPrompt(prompt);
        return b;
    }

    /// <summary>
    /// The vocabulary hint the way whisper reads it best: plain words separated by commas. Quotes are dropped:
    /// whisper continues the style of its prompt, and a quoted list made it put quotes in the transcript.
    /// </summary>
    public static string? VocabularyPrompt(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var quotes = new[] { '"', '\u201C', '\u201D', '\u201E', '\u00AB', '\u00BB', '\'', '\u2018', '\u2019', '`', '\u00B4' };
        var words = Regex.Split(raw, @"[,;\r\n]+")
            .Select(w => Regex.Replace(w.Trim().Trim(quotes).Trim(), @"\s+", " "))
            .Where(w => w.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        if (words.Count == 0) return null;
        var text = string.Join(", ", words);
        return text.EndsWith('.') ? text : text + ".";
    }

    /// <summary>"Auto" on a whole recording: Spanish unless its first half minute is clearly English.</summary>
    private static string PickFileLanguage(WhisperProcessor proc, float[] samples)
    {
        try
        {
            var head = samples.AsSpan(0, Math.Min(samples.Length, 16000 * 30));
            var (lang, p) = proc.DetectLanguageWithProbability(head, AutoLanguages);
            return lang == "en" && p >= 0.7f ? "en" : "es";
        }
        catch (Exception ex) { Log.Error("Asr.DetectFile", ex); return "es"; }
    }

    /// <summary>
    /// A decoded piece worth keeping: not text in another script (Japanese, Cyrillic… when the language is a
    /// Latin one) and not decoded with very low confidence (what whisper writes for noise).
    /// </summary>
    private static bool Plausible(SegmentData seg)
    {
        if (seg.Probability > 0 && seg.Probability < MinProbability) return false;
        return !ForeignScript(seg.Text);
    }

    private const float MinProbability = 0.25f;

    /// <summary>True when most letters are not Latin (every language MarkNotes offers is written in Latin letters).</summary>
    public static bool ForeignScript(string? text)
    {
        int letters = 0, other = 0;
        foreach (var ch in text ?? "")
        {
            if (!char.IsLetter(ch)) continue;
            letters++;
            if (ch > '\u024F' && !(ch >= '\u1E00' && ch <= '\u1EFF')) other++;
        }
        return letters > 0 && other * 10 > letters * 3;
    }

    /// <summary>Decodes any audio/video file Windows can read (mp3, m4a, wav, mp4…) to 16 kHz mono.</summary>
    private static float[] LoadAudio16k(string file)
    {
        using var reader = new MediaFoundationReader(file);
        if (reader.TotalTime > TimeSpan.FromHours(4)) throw new InvalidOperationException(UiLang.T("The file is longer than 4 hours.", "El archivo dura más de 4 horas."));
        using var resampler = new MediaFoundationResampler(reader, WaveFormat.CreateIeeeFloatWaveFormat(16000, 1)) { ResamplerQuality = 60 };
        var samples = new List<float>((int)Math.Min(int.MaxValue / 2, reader.TotalTime.TotalSeconds * 16000 + 16000));
        var buf = new byte[16000 * 4];
        int n;
        while ((n = resampler.Read(buf, 0, buf.Length)) > 0)
            for (int i = 0; i + 3 < n; i += 4) samples.Add(BitConverter.ToSingle(buf, i));
        return samples.ToArray();
    }

    /// <summary>Transcribes a recording (voice memo, meeting, video) offline.</summary>
    public async Task<object> TranscribeFileAsync(string file, AsrStartOptions o)
    {
        if (Running) throw new InvalidOperationException(UiLang.T("Stop the live transcription first.", "Primero detené la transcripción en vivo."));
        var model = FindModel(o.ModelId);
        var path = ModelPath(model);
        if (!File.Exists(path)) throw new InvalidOperationException(UiLang.T($"The \"{model.Label}\" speech model is not downloaded yet.", $"El modelo de voz \"{model.Label}\" todavía no está descargado."));
        var sw = Stopwatch.StartNew();
        _emit("asr.file", new { stage = "decoding", name = Path.GetFileName(file) });
        var samples = await Task.Run(() => LoadAudio16k(file));
        double total = samples.Length / 16000.0;
        _emit("asr.file", new { stage = "loading", total });
        var segments = new List<object>();
        await Task.Run(async () =>
        {
            ChooseLibrary(o.UseGpu);
            using var factory = WhisperFactory.FromPath(path, new WhisperFactoryOptions { UseGpu = o.UseGpu });
            await using var proc = Configure(factory.CreateBuilder(), o, live: false).Build();
            Backend = RuntimeOptions.LoadedLibrary?.ToString() ?? Backend;
            if (IsAuto(o)) proc.ChangeLanguage(PickFileLanguage(proc, samples));
            _emit("asr.file", new { stage = "transcribing", done = 0.0, total, backend = Backend });
            await foreach (var seg in proc.ProcessAsync(samples))
            {
                var text = Plausible(seg) ? Clean(seg.Text) : "";
                if (text.Length > 0) segments.Add(new { start = seg.Start.TotalSeconds, end = seg.End.TotalSeconds, text, lang = seg.Language });
                _emit("asr.file", new { stage = "transcribing", done = seg.End.TotalSeconds, total, backend = Backend });
            }
        });
        _emit("asr.file", new { stage = "done" });
        return new { segments, seconds = total, elapsedMs = sw.ElapsedMilliseconds, backend = Backend, name = Path.GetFileName(file) };
    }

    // ───────────────────────────── recording ─────────────────────────────

    public async Task StartAsync(AsrStartOptions o)
    {
        if (Running) return;
        var model = FindModel(o.ModelId);
        var path = ModelPath(model);
        if (!File.Exists(path)) throw new InvalidOperationException(UiLang.T($"The \"{model.Label}\" speech model is not downloaded yet. Open Settings › Transcription.", $"El modelo de voz \"{model.Label}\" todavía no está descargado. Abrí Configuración › Transcripción."));
        if (!o.Mic && !o.Desktop) throw new InvalidOperationException(UiLang.T("Choose at least one audio source (microphone or desktop audio).", "Elegí al menos una fuente de audio (micrófono o audio del escritorio)."));

        _emit("asr.state", new { state = "loading" });
        await Task.Run(() =>
        {
            ChooseLibrary(o.UseGpu);
            _factory = WhisperFactory.FromPath(path, new WhisperFactoryOptions { UseGpu = o.UseGpu });
            _processor = Configure(_factory.CreateBuilder(), o, live: true).Build();
            _auto = IsAuto(o);
            _lang = _auto ? "es" : o.Language;
            _langBySource.Clear();
            Backend = RuntimeOptions.LoadedLibrary?.ToString() ?? (o.UseGpu ? "GPU" : "CPU");
        });

        _cts = new CancellationTokenSource();
        _queue = Channel.CreateUnbounded<AudioChunk>();
        try
        {
            using var en = new MMDeviceEnumerator();
            if (o.Mic)
            {
                var dev = PickDevice(en, DataFlow.Capture, o.MicDevice);
                _sources.Add(new AudioSource("mic", new WasapiCapture(dev, true, 100), Enqueue));
            }
            if (o.Desktop)
            {
                var dev = PickDevice(en, DataFlow.Render, o.DesktopDevice);
                _sources.Add(new AudioSource("desktop", new WasapiLoopbackCapture(dev), Enqueue));
            }
            foreach (var s in _sources) s.Start();
        }
        catch
        {
            await StopAsync();
            throw;
        }

        Running = true;
        var token = _cts.Token;
        _worker = Task.Run(() => WorkerLoop(token));
        _levelTimer = new System.Threading.Timer(_ =>
        {
            var lv = _sources.ToDictionary(s => s.Name, s => Math.Round(s.Level, 3));
            _emit("asr.level", new { levels = lv, pending = Volatile.Read(ref _pending) });
        }, null, 150, 150);
        _emit("asr.state", new { state = "running", backend = Backend, sources = _sources.Select(s => s.Name).ToArray() });
    }

    private static MMDevice PickDevice(MMDeviceEnumerator en, DataFlow flow, string? id)
    {
        if (!string.IsNullOrWhiteSpace(id))
        {
            try { return en.GetDevice(id); } catch { /* fall back to default */ }
        }
        return en.GetDefaultAudioEndpoint(flow, flow == DataFlow.Capture ? Role.Communications : Role.Multimedia);
    }

    private void Enqueue(AudioChunk c)
    {
        if (_queue == null) return;
        Interlocked.Increment(ref _pending);
        if (!_queue.Writer.TryWrite(c)) Interlocked.Decrement(ref _pending);
    }

    private async Task WorkerLoop(CancellationToken ct)
    {
        var reader = _queue!.Reader;
        try
        {
            await foreach (var chunk in reader.ReadAllAsync(CancellationToken.None))
            {
                try
                {
                    if (ct.IsCancellationRequested && _processor == null) break;
                    var samples = chunk.Samples;
                    if (samples.Length < 17600)
                    {
                        var padded = new float[17600];
                        Array.Copy(samples, padded, samples.Length);
                        samples = padded;
                    }
                    if (_auto)
                    {
                        var pick = PickLanguage(chunk.Source, chunk.Samples, samples);
                        if (pick != _lang) { _processor!.ChangeLanguage(pick); _lang = pick; }
                    }
                    var sb = new StringBuilder();
                    string? lang = null;
                    await foreach (var seg in _processor!.ProcessAsync(samples, CancellationToken.None))
                    {
                        if (!Plausible(seg)) continue;
                        sb.Append(seg.Text);
                        lang ??= seg.Language;
                    }
                    var text = Clean(sb.ToString());
                    if (text.Length > 0)
                        _emit("asr.segment", new
                        {
                            source = chunk.Source,
                            text,
                            lang,
                            at = new DateTimeOffset(chunk.Start).ToUnixTimeMilliseconds(),
                            seconds = Math.Round(chunk.Samples.Length / 16000.0, 1),
                        });
                }
                catch (Exception ex)
                {
                    Log.Error("Asr.Process", ex);
                    _emit("asr.state", new { state = "warning", message = ex.Message });
                }
                finally
                {
                    Interlocked.Decrement(ref _pending);
                }
            }
        }
        catch (Exception ex) { Log.Error("Asr.Worker", ex); }
    }

    /// <summary>
    /// "Auto" for one phrase: Spanish or English. Detection needs a couple of seconds of speech, so a short phrase
    /// keeps the language its speaker used last; an unsure guess does too (Spanish to begin with).
    /// </summary>
    private string PickLanguage(string source, float[] original, float[] samples)
    {
        var last = _langBySource.TryGetValue(source, out var l) ? l : "es";
        if (original.Length < 16000 * 2) return last;
        try
        {
            var (lang, p) = _processor!.DetectLanguageWithProbability(samples, AutoLanguages);
            if ((lang == "es" || lang == "en") && p >= 0.7f) _langBySource[source] = last = lang;
        }
        catch (Exception ex) { Log.Error("Asr.Detect", ex); }
        return last;
    }

    private static readonly Regex Bracketed = new(@"^\s*[\[\(\*♪].*[\]\)\*♪]\s*$", RegexOptions.Compiled);
    private static readonly Regex Junk = new(
        @"(amara\.org|subt[ií]tulos (realizados )?por|thanks for watching|thank you for watching|gracias por ver|suscr[ií]bete|subscribe to|subtitles by|www\.\S+\.(com|org))",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>Drops whisper's well-known "hallucinations" on noise and music.</summary>
    public static string Clean(string raw)
    {
        var t = Regex.Replace(raw ?? "", @"\s+", " ").Trim();
        t = Regex.Replace(t, @"\[(BLANK_AUDIO|MUSIC|Music|NO_SPEECH|SILENCE)\]", "", RegexOptions.IgnoreCase).Trim();
        if (t.Length == 0 || Bracketed.IsMatch(t) || Junk.IsMatch(t)) return "";
        if (Regex.IsMatch(t, @"^[\s\p{P}♪]*$")) return "";
        if (t.Equals("you", StringComparison.OrdinalIgnoreCase) || t.Equals("you.", StringComparison.OrdinalIgnoreCase)) return "";
        if (ForeignScript(t)) return "";
        // Quotes around what was said (whisper copies them from a quoted vocabulary list).
        t = Regex.Replace(t.Replace("\"", "").Replace("\u201C", "").Replace("\u201D", ""), @"\s+", " ").Trim();
        if (Regex.IsMatch(t, @"^[\s\p{P}]*$")) return "";
        return t;
    }

    public async Task StopAsync()
    {
        _levelTimer?.Dispose();
        _levelTimer = null;
        foreach (var s in _sources)
        {
            try { s.Stop(); } catch (Exception ex) { Log.Error("Asr.StopSource", ex); }
        }
        _queue?.Writer.TryComplete();
        if (_worker != null)
        {
            _emit("asr.state", new { state = "finishing", pending = Volatile.Read(ref _pending) });
            await Task.WhenAny(_worker, Task.Delay(TimeSpan.FromSeconds(60)));
        }
        _cts?.Cancel();
        foreach (var s in _sources) s.Dispose();
        _sources.Clear();
        try { if (_processor != null) await _processor.DisposeAsync(); } catch (Exception ex) { Log.Error("Asr.DisposeProcessor", ex); }
        _processor = null;
        _factory?.Dispose();
        _factory = null;
        _worker = null;
        _queue = null;
        Running = false;
        _emit("asr.state", new { state = "stopped" });
    }

    public void Dispose()
    {
        try { StopAsync().Wait(3000); } catch { }
        lock (_gate)
            foreach (var d in _downloads.Values) d.Cancel();
    }
}

internal sealed record AudioChunk(string Source, float[] Samples, DateTime Start);

/// <summary>One capture device: converts to 16 kHz mono and cuts speech at pauses.</summary>
internal sealed class AudioSource : IDisposable
{
    private const int Rate = 16000;
    private readonly IWaveIn _capture;
    private readonly Action<AudioChunk> _onChunk;
    private readonly WaveFormat _fmt;
    private readonly bool _isFloat;
    private readonly WdlResampler _resampler;
    private readonly Segmenter _segmenter;
    private float[] _mono = new float[4096];
    private float[] _out = new float[4096];

    public string Name { get; }
    public float Level => _segmenter.Level;

    public AudioSource(string name, IWaveIn capture, Action<AudioChunk> onChunk)
    {
        Name = name;
        _capture = capture;
        _onChunk = onChunk;
        _fmt = capture.WaveFormat;
        _isFloat = _fmt.Encoding == WaveFormatEncoding.IeeeFloat ||
                   (_fmt is WaveFormatExtensible ext && ext.SubFormat == new Guid("00000003-0000-0010-8000-00aa00389b71"));
        _resampler = new WdlResampler();
        _resampler.SetMode(true, 2, false);
        _resampler.SetFilterParms();
        _resampler.SetFeedMode(true);
        _resampler.SetRates(_fmt.SampleRate, Rate);
        _segmenter = new Segmenter(samples => _onChunk(new AudioChunk(Name, samples.Item1, samples.Item2)));
        _capture.DataAvailable += OnData;
    }

    public void Start() => _capture.StartRecording();

    public void Stop()
    {
        _capture.StopRecording();
        _segmenter.Flush();
    }

    private void OnData(object? sender, WaveInEventArgs e)
    {
        try
        {
            int ch = Math.Max(1, _fmt.Channels);
            int bytesPerSample = _fmt.BitsPerSample / 8;
            int frames = e.BytesRecorded / (bytesPerSample * ch);
            if (frames <= 0) return;
            if (_mono.Length < frames) _mono = new float[frames * 2];
            var buf = e.Buffer;
            for (int f = 0; f < frames; f++)
            {
                float sum = 0;
                int baseIdx = f * ch * bytesPerSample;
                for (int c = 0; c < ch; c++)
                {
                    int i = baseIdx + c * bytesPerSample;
                    float v;
                    if (_isFloat && bytesPerSample == 4) v = BitConverter.ToSingle(buf, i);
                    else if (bytesPerSample == 2) v = BitConverter.ToInt16(buf, i) / 32768f;
                    else if (bytesPerSample == 3) v = ((buf[i] << 8 | buf[i + 1] << 16 | buf[i + 2] << 24) >> 8) / 8388608f;
                    else if (bytesPerSample == 4) v = BitConverter.ToInt32(buf, i) / 2147483648f;
                    else v = 0;
                    sum += v;
                }
                _mono[f] = sum / ch;
            }
            int need = _resampler.ResamplePrepare(frames, 1, out float[] inBuf, out int inOff);
            Array.Copy(_mono, 0, inBuf, inOff, Math.Min(frames, need));
            int maxOut = (int)((long)frames * Rate / _fmt.SampleRate) + 64;
            if (_out.Length < maxOut) _out = new float[maxOut * 2];
            int produced = _resampler.ResampleOut(_out, 0, Math.Min(frames, need), maxOut, 1);
            if (produced > 0) _segmenter.Push(_out, produced);
        }
        catch (Exception ex) { Log.Error("AudioSource.OnData " + Name, ex); }
    }

    public void Dispose()
    {
        _capture.DataAvailable -= OnData;
        try { _capture.Dispose(); } catch { }
    }
}

/// <summary>Energy based voice activity detection with an adaptive noise floor.</summary>
internal sealed class Segmenter
{
    private const int Frame = 480;           // 30 ms
    private const int PreRollFrames = 10;    // 300 ms kept before speech starts
    private const int HangoverFrames = 26;   // ~0.8 s of quiet ends a phrase
    private const int MaxSamples = 16000 * 24;
    private const int MinSamples = 16000 / 2;
    private const int MinLoudFrames = 6;     // ~0.2 s of sound: clicks and knocks alone are not a phrase

    private readonly Action<(float[], DateTime)> _emit;
    private readonly float[] _frame = new float[Frame];
    private int _fill;
    private readonly Queue<float[]> _preRoll = new();
    private readonly List<float> _segment = new();
    private bool _inSpeech;
    private int _loudRun, _quietRun, _loudFrames;
    private double _noiseDb = -55;
    private DateTime _segStart;
    private readonly object _gate = new();

    public float Level { get; private set; }

    public Segmenter(Action<(float[], DateTime)> emit) => _emit = emit;

    public void Push(float[] data, int count)
    {
        lock (_gate)
        {
            for (int i = 0; i < count; i++)
            {
                _frame[_fill++] = data[i];
                if (_fill == Frame)
                {
                    ProcessFrame();
                    _fill = 0;
                }
            }
        }
    }

    private void ProcessFrame()
    {
        double sum = 0;
        for (int i = 0; i < Frame; i++) sum += _frame[i] * _frame[i];
        double db = 10 * Math.Log10(sum / Frame + 1e-12);
        Level = (float)Math.Clamp((db + 60) / 55, 0, 1);
        bool loud = db > Math.Max(_noiseDb + 9, -50);

        if (!_inSpeech)
        {
            _preRoll.Enqueue((float[])_frame.Clone());
            if (_preRoll.Count > PreRollFrames) _preRoll.Dequeue();
            // Track the background level while nobody talks.
            _noiseDb = db < _noiseDb ? _noiseDb * 0.9 + db * 0.1 : _noiseDb * 0.995 + db * 0.005;
            _noiseDb = Math.Clamp(_noiseDb, -80, -25);
            _loudRun = loud ? _loudRun + 1 : 0;
            if (_loudRun >= 3)
            {
                _inSpeech = true;
                _quietRun = 0;
                _loudFrames = _loudRun;
                _segment.Clear();
                _segStart = DateTime.Now - TimeSpan.FromMilliseconds(_preRoll.Count * 30);
                foreach (var f in _preRoll) _segment.AddRange(f);
                _preRoll.Clear();
            }
        }
        else
        {
            _segment.AddRange(_frame);
            _quietRun = loud ? 0 : _quietRun + 1;
            if (loud) _loudFrames++;
            if (_quietRun >= HangoverFrames || _segment.Count >= MaxSamples) EmitSegment();
        }
    }

    private void EmitSegment()
    {
        if (_segment.Count >= MinSamples && _loudFrames >= MinLoudFrames) _emit((_segment.ToArray(), _segStart));
        _segment.Clear();
        _inSpeech = false;
        _loudRun = 0;
        _quietRun = 0;
    }

    public void Flush()
    {
        lock (_gate)
        {
            if (_inSpeech) EmitSegment();
        }
    }
}
