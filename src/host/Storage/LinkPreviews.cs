using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace MarkNotes.Storage;

/// <summary>
/// Title + thumbnail of web links (YouTube videos, pages with Open Graph tags), downloaded once and
/// kept in %LOCALAPPDATA%\MarkNotes\linkcache. Each entry remembers which notes/canvases use it;
/// when no document uses a link any more its preview is deleted, so adding it again fetches it fresh.
/// This is the only feature that goes online, and only for links the user wrote (can be turned off).
/// </summary>
public sealed class LinkPreviews
{
    public sealed class Entry
    {
        public string Url { get; set; } = "";
        public string? Title { get; set; }
        public string? Site { get; set; }
        public string? Image { get; set; }
        public long Fetched { get; set; }
        public bool Failed { get; set; }
        public HashSet<string> Refs { get; set; } = new(StringComparer.OrdinalIgnoreCase);
        /// <summary>The site could not be reached (offline, timeout, busy): try again soon rather than tomorrow.</summary>
        public bool Transient { get; set; }
        /// <summary>page | youtube | tweet</summary>
        public string? Kind { get; set; }
        public string? VideoId { get; set; }
        // X posts
        public string? Author { get; set; }
        public string? Handle { get; set; }
        public string? Avatar { get; set; }
        public string? Text { get; set; }
        public string? Date { get; set; }
        public long Likes { get; set; }
        public bool Verified { get; set; }
        public List<MediaItem>? Media { get; set; }
        /// <summary>The post this one quotes.</summary>
        public Entry? Quote { get; set; }
    }

    public sealed class MediaItem
    {
        /// <summary>photo | video | gif</summary>
        public string Kind { get; set; } = "photo";
        /// <summary>The picture (or the video's poster), kept in the cache folder.</summary>
        public string? Image { get; set; }
        /// <summary>The video file on video.twimg.com, played inside MarkNotes.</summary>
        public string? Video { get; set; }
        public double Ratio { get; set; }
    }

    // A canvas full of posts asks for all of them at once: a few at a time keeps sites from refusing.
    private static readonly SemaphoreSlim FetchGate = new(4);

    private static readonly HttpClient Http = CreateClient();
    private static readonly Regex YouTubeRx = new(@"(?:youtube\.com/(?:watch\?(?:[^#]*&)?v=|shorts/|embed/|live/)|youtu\.be/)([A-Za-z0-9_-]{11})", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex MetaRx = new(@"<meta\b[^>]*>", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex AttrRx = new(@"([a-zA-Z_:-]+)\s*=\s*(?:""([^""]*)""|'([^']*)'|([^\s>]+))", RegexOptions.Compiled);
    private static readonly Regex TitleRx = new(@"<title[^>]*>([\s\S]*?)</title>", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex TweetRx = new(@"(?:^|//)(?:www\.|mobile\.)?(?:x|twitter)\.com/(?:[^/?#]+|i(?:/web)?)/status(?:es)?/(\d{5,25})", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private readonly string _dir;
    private readonly string _root;
    private readonly object _gate = new();
    private readonly ConcurrentDictionary<string, Task<Entry>> _inflight = new();
    private Dictionary<string, Entry>? _entries;
    private System.Threading.Timer? _saveTimer;

    public LinkPreviews(string dir, string notesRoot)
    {
        _dir = dir;
        _root = notesRoot;
    }

    private static HttpClient CreateClient()
    {
        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = true,
            MaxAutomaticRedirections = 6,
            UseCookies = false,
            AutomaticDecompression = DecompressionMethods.All,
            ConnectTimeout = TimeSpan.FromSeconds(6),
        };
        var c = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(12) };
        c.DefaultRequestHeaders.UserAgent.ParseAdd("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 MarkNotes/2");
        c.DefaultRequestHeaders.AcceptLanguage.ParseAdd("es-AR,es;q=0.9,en;q=0.8");
        return c;
    }

    private string IndexFile => Path.Combine(_dir, "index.json");

    private Dictionary<string, Entry> Entries()
    {
        if (_entries != null) return _entries;
        _entries = new Dictionary<string, Entry>(StringComparer.Ordinal);
        try
        {
            if (File.Exists(IndexFile))
            {
                var list = JsonSerializer.Deserialize<List<Entry>>(File.ReadAllText(IndexFile));
                if (list != null)
                    foreach (var e in list)
                    {
                        e.Refs = new HashSet<string>(e.Refs ?? new(), StringComparer.OrdinalIgnoreCase);
                        _entries[e.Url] = e;
                    }
            }
        }
        catch (Exception ex) { Log.Error("LinkPreviews.Load", ex); }
        return _entries;
    }

    private void SaveSoon()
    {
        _saveTimer ??= new System.Threading.Timer(_ => Save(), null, Timeout.Infinite, Timeout.Infinite);
        _saveTimer.Change(1200, Timeout.Infinite);
    }

    public void Save()
    {
        string json;
        lock (_gate)
        {
            if (_entries == null) return;
            json = JsonSerializer.Serialize(_entries.Values.ToList());
        }
        try
        {
            Directory.CreateDirectory(_dir);
            File.WriteAllText(IndexFile + ".tmp", json);
            File.Move(IndexFile + ".tmp", IndexFile, true);
        }
        catch (Exception ex) { Log.Error("LinkPreviews.Save", ex); }
    }

    private string? Local(string? file)
    {
        if (file == null) return null;
        var p = Path.Combine(_dir, file);
        return File.Exists(p) ? NoteStore.FileUrl(p, _root) : null;
    }

    private object Dto(Entry e) => new
    {
        url = e.Url, title = e.Title, site = e.Site, image = Local(e.Image), failed = e.Failed, transient = e.Failed && e.Transient,
        kind = e.Kind ?? "page", videoId = e.VideoId,
        author = e.Author, handle = e.Handle, avatar = Local(e.Avatar), text = e.Text,
        date = e.Date, likes = e.Likes, verified = e.Verified,
        media = e.Media?.Select(m => new { kind = m.Kind, image = Local(m.Image), video = m.Video, ratio = m.Ratio }).ToList(),
        quote = e.Quote == null ? null : Dto(e.Quote),
    };

    /// <summary>Every file an entry keeps in the cache folder (picture, avatar, media, quoted post).</summary>
    private static IEnumerable<string> FilesOf(Entry e)
    {
        if (e.Image != null) yield return e.Image;
        if (e.Avatar != null) yield return e.Avatar;
        if (e.Media != null)
            foreach (var m in e.Media)
                if (m.Image != null) yield return m.Image;
        if (e.Quote != null)
            foreach (var f in FilesOf(e.Quote)) yield return f;
    }

    private void DeleteFiles(Entry e, Entry? keep = null)
    {
        var keepSet = keep == null ? null : new HashSet<string>(FilesOf(keep), StringComparer.OrdinalIgnoreCase);
        foreach (var f in FilesOf(e).Distinct(StringComparer.OrdinalIgnoreCase))
            if (keepSet == null || !keepSet.Contains(f)) TryDelete(f);
    }

    public static bool IsTweet(string url) => TweetRx.IsMatch(url);

    private static bool IsWebUrl(string url, out Uri uri) =>
        Uri.TryCreate(url, UriKind.Absolute, out uri!) && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps);

    /// <summary>The preview of a link used by document <paramref name="doc"/> (fetched once, then from the cache).</summary>
    public async Task<object?> GetAsync(string url, string doc)
    {
        url = url.Trim();
        if (!IsWebUrl(url, out _)) return null;
        lock (_gate)
        {
            if (Entries().TryGetValue(url, out var e) && !(IsTweet(url) && e.Kind != "tweet"))
            {
                // Failed lookups are retried: soon when the site could not be reached, after a day otherwise.
                var age = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - e.Fetched;
                if (!e.Failed || age < (e.Transient ? 90_000 : 86_400_000))
                {
                    if (doc.Length > 0 && e.Refs.Add(doc)) SaveSoon();
                    return Dto(e);
                }
            }
        }
        var entry = await _inflight.GetOrAdd(url, u => Task.Run(() => FetchAsync(u)));
        _inflight.TryRemove(url, out _);
        lock (_gate)
        {
            var map = Entries();
            if (map.TryGetValue(url, out var old) && old != entry)
            {
                foreach (var r in old.Refs) entry.Refs.Add(r);
                DeleteFiles(old, entry);
            }
            if (doc.Length > 0) entry.Refs.Add(doc);
            map[url] = entry;
            SaveSoon();
            return Dto(entry);
        }
    }

    /// <summary>The preview already kept on this PC, without going online (null when there is none).</summary>
    public object? Cached(string url)
    {
        lock (_gate)
            return Entries().TryGetValue(url.Trim(), out var e) && !e.Failed ? Dto(e) : null;
    }

    /// <summary>Document <paramref name="doc"/> now uses exactly these links: previews nobody uses any more are deleted.</summary>
    public void Sync(string doc, IEnumerable<string> urls)
    {
        var keep = new HashSet<string>(urls.Select(u => u.Trim()), StringComparer.Ordinal);
        lock (_gate)
        {
            var map = Entries();
            bool changed = false;
            foreach (var e in map.Values.ToList())
            {
                if (keep.Contains(e.Url) || !e.Refs.Remove(doc)) continue;
                changed = true;
                if (e.Refs.Count == 0)
                {
                    map.Remove(e.Url);
                    DeleteFiles(e);
                }
            }
            if (changed) SaveSoon();
        }
    }

    /// <summary>A note or canvas was renamed or moved: its links now belong to the new path.</summary>
    public void Rename(string from, string to)
    {
        lock (_gate)
        {
            bool changed = false;
            foreach (var e in Entries().Values)
                if (e.Refs.Remove(from)) { e.Refs.Add(to); changed = true; }
            if (changed) SaveSoon();
        }
    }

    /// <summary>Drops the cached preview and downloads it again.</summary>
    public async Task<object?> RefreshAsync(string url, string doc)
    {
        lock (_gate)
        {
            var map = Entries();
            if (map.Remove(url.Trim(), out var e))
            {
                DeleteFiles(e);
                // Keep who uses it, the new entry takes over the references.
                map[url.Trim()] = new Entry { Url = url.Trim(), Refs = e.Refs, Failed = true, Fetched = 0 };
            }
        }
        return await GetAsync(url, doc);
    }

    private void TryDelete(string file)
    {
        try { File.Delete(Path.Combine(_dir, file)); } catch { }
    }

    private static string Hash(string s) => Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes(s)))[..20].ToLowerInvariant();

    private async Task<Entry> FetchAsync(string url)
    {
        await FetchGate.WaitAsync();
        try { return await FetchOneAsync(url); }
        finally { FetchGate.Release(); }
    }

    private static bool IsTransient(Exception ex) => ex switch
    {
        TaskCanceledException or TimeoutException or IOException => true,
        HttpRequestException h => h.StatusCode == null || (int)h.StatusCode.Value == 429 || (int)h.StatusCode.Value >= 500,
        _ => false,
    };

    private async Task<Entry> FetchOneAsync(string url)
    {
        var entry = new Entry { Url = url, Fetched = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
        try
        {
            string? imageUrl;
            var yt = YouTubeRx.Match(url);
            var tw = TweetRx.Match(url);
            if (tw.Success)
            {
                await FetchTweetAsync(entry, tw.Groups[1].Value, url);
                return entry;
            }
            if (yt.Success)
            {
                var id = yt.Groups[1].Value;
                entry.Kind = "youtube";
                entry.VideoId = id;
                entry.Site = "YouTube";
                imageUrl = $"https://i.ytimg.com/vi/{id}/hqdefault.jpg";
                try
                {
                    var json = await Http.GetStringAsync("https://www.youtube.com/oembed?format=json&url=" + Uri.EscapeDataString("https://www.youtube.com/watch?v=" + id));
                    using var d = JsonDocument.Parse(json);
                    if (d.RootElement.TryGetProperty("title", out var t)) entry.Title = t.GetString();
                    if (d.RootElement.TryGetProperty("author_name", out var a) && a.GetString() is string author && author.Length > 0) entry.Site = "YouTube · " + author;
                }
                catch (Exception ex) { Log.Info("LinkPreviews oEmbed " + ex.Message); }
            }
            else
            {
                using var resp = await Http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
                resp.EnsureSuccessStatusCode();
                entry.Kind = "page";
                var finalUri = resp.RequestMessage?.RequestUri ?? new Uri(url);
                entry.Site = finalUri.Host.StartsWith("www.") ? finalUri.Host[4..] : finalUri.Host;
                var type = resp.Content.Headers.ContentType?.MediaType ?? "";
                if (type.StartsWith("image/"))
                {
                    imageUrl = finalUri.ToString();
                }
                else
                {
                    var html = await ReadLimitedStringAsync(resp, 1_500_000);
                    var meta = ParseMeta(html);
                    entry.Title = First(meta, "og:title", "twitter:title") ?? Clean(TitleRx.Match(html) is { Success: true } m ? m.Groups[1].Value : null);
                    var site = First(meta, "og:site_name", "application-name");
                    if (!string.IsNullOrWhiteSpace(site)) entry.Site = site;
                    var img = First(meta, "og:image", "og:image:url", "twitter:image", "twitter:image:src");
                    imageUrl = img != null && Uri.TryCreate(finalUri, img, out var abs) ? abs.ToString() : null;
                }
            }
            if (imageUrl != null) entry.Image = await DownloadImageAsync(imageUrl, url);
            entry.Failed = entry.Title == null && entry.Image == null;
        }
        catch (Exception ex)
        {
            Log.Info($"LinkPreviews {url}: {ex.Message}");
            entry.Failed = true;
            entry.Transient = IsTransient(ex);
        }
        return entry;
    }

    /// <summary>The token the public tweet embed data expects (same as X's own embed code computes).</summary>
    private static string SyndicationToken(string id)
    {
        double x = double.Parse(id, System.Globalization.CultureInfo.InvariantCulture) / 1e15 * Math.PI;
        const string digits = "0123456789abcdefghijklmnopqrstuvwxyz";
        long ip = (long)Math.Floor(x);
        double fp = x - ip;
        var whole = new StringBuilder();
        do { whole.Insert(0, digits[(int)(ip % 36)]); ip /= 36; } while (ip > 0);
        var sb = new StringBuilder(whole.ToString()).Append('.');
        for (int i = 0; i < 12; i++) { fp *= 36; int d = (int)fp; sb.Append(digits[d]); fp -= d; }
        return Regex.Replace(sb.ToString(), "(0+|\\.)", "");
    }

    /// <summary>An X post: author, text, pictures and video files, so it can be shown and played inside MarkNotes.</summary>
    private async Task FetchTweetAsync(Entry entry, string id, string url)
    {
        entry.Kind = "tweet";
        entry.Site = "X";
        using var resp = await Http.GetAsync($"https://cdn.syndication.twimg.com/tweet-result?id={id}&lang=en&token={SyndicationToken(id)}");
        if (resp.StatusCode == HttpStatusCode.NotFound)
        {
            entry.Failed = true;
            entry.Title = "This post is unavailable.";
            return;
        }
        resp.EnsureSuccessStatusCode();
        using var d = JsonDocument.Parse(await resp.Content.ReadAsStringAsync());
        var root = d.RootElement;
        if (root.TryGetProperty("tombstone", out var tomb) || !root.TryGetProperty("user", out _))
        {
            // Deleted, protected or withheld: say so like X does ("This Post was deleted by the Post author.").
            entry.Failed = true;
            string? why = null;
            if (tomb.ValueKind == JsonValueKind.Object && tomb.TryGetProperty("text", out var tt) && tt.TryGetProperty("text", out var ts)) why = ts.GetString();
            entry.Title = string.IsNullOrWhiteSpace(why) ? "This post is unavailable." : Regex.Replace(why, @"\s*Learn more\s*$", "").Trim();
            return;
        }
        await ReadTweetAsync(entry, root, url, "");
        if (entry.Handle != null) entry.Site = "@" + entry.Handle + " · X";
        if (root.TryGetProperty("quoted_tweet", out var q) && q.ValueKind == JsonValueKind.Object && q.TryGetProperty("user", out _))
        {
            var quote = new Entry { Kind = "tweet", Site = "X", Fetched = entry.Fetched };
            await ReadTweetAsync(quote, q, url, "#q");
            var qid = q.TryGetProperty("id_str", out var qi) ? qi.GetString() : null;
            quote.Url = qid != null && quote.Handle != null ? $"https://x.com/{quote.Handle}/status/{qid}" : url;
            entry.Quote = quote;
        }
    }

    /// <summary>Fills author, text, date, likes and media of a post (or of the post it quotes, key "#q").</summary>
    private async Task ReadTweetAsync(Entry entry, JsonElement tw, string url, string key)
    {
        var user = tw.GetProperty("user");
        entry.Author = user.TryGetProperty("name", out var n) ? n.GetString() : null;
        entry.Handle = user.TryGetProperty("screen_name", out var h) ? h.GetString() : null;
        entry.Verified = (user.TryGetProperty("is_blue_verified", out var bv) && bv.ValueKind == JsonValueKind.True) ||
                         (user.TryGetProperty("verified", out var v) && v.ValueKind == JsonValueKind.True);
        var text = tw.TryGetProperty("text", out var t) ? t.GetString() ?? "" : "";
        // Short t.co links become the real addresses; the ones pointing at the media or the quoted post go away.
        if (tw.TryGetProperty("entities", out var ents))
        {
            if (ents.TryGetProperty("urls", out var urls) && urls.ValueKind == JsonValueKind.Array)
                foreach (var u in urls.EnumerateArray())
                {
                    var shortUrl = u.TryGetProperty("url", out var su) ? su.GetString() : null;
                    var expanded = u.TryGetProperty("expanded_url", out var eu) ? eu.GetString() : null;
                    if (string.IsNullOrEmpty(shortUrl)) continue;
                    var isQuote = expanded != null && TweetRx.IsMatch(expanded) && tw.TryGetProperty("quoted_tweet", out _);
                    text = text.Replace(shortUrl, isQuote ? "" : expanded ?? shortUrl);
                }
            if (ents.TryGetProperty("media", out var em) && em.ValueKind == JsonValueKind.Array)
                foreach (var m in em.EnumerateArray())
                    if (m.TryGetProperty("url", out var mu) && mu.GetString() is string s && s.Length > 0) text = text.Replace(s, "");
        }
        text = WebUtility.HtmlDecode(text);
        text = Regex.Replace(text, @"(\s*https://t\.co/\w+)+\s*$", "").Trim();
        entry.Text = text;
        entry.Title = text.Length > 0 ? (text.Length > 140 ? text[..140] + "…" : text) : entry.Author;
        if (tw.TryGetProperty("created_at", out var c) && DateTime.TryParse(c.GetString(), System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.AdjustToUniversal, out var when)) entry.Date = when.ToString("o");
        if (tw.TryGetProperty("favorite_count", out var fav) && fav.TryGetInt64(out var likes)) entry.Likes = likes;

        if (tw.TryGetProperty("mediaDetails", out var media) && media.ValueKind == JsonValueKind.Array)
        {
            var list = new List<MediaItem>();
            int i = 0;
            foreach (var m in media.EnumerateArray())
            {
                if (i >= 4) break;
                var type = m.TryGetProperty("type", out var ty) ? ty.GetString() : "photo";
                var item = new MediaItem { Kind = type == "animated_gif" ? "gif" : type == "video" ? "video" : "photo" };
                if (m.TryGetProperty("original_info", out var oi) && oi.TryGetProperty("width", out var ow) && oi.TryGetProperty("height", out var oh) &&
                    ow.TryGetDouble(out var w) && oh.TryGetDouble(out var hh) && hh > 0) item.Ratio = w / hh;
                if (m.TryGetProperty("video_info", out var vi))
                {
                    if (vi.TryGetProperty("aspect_ratio", out var ar) && ar.ValueKind == JsonValueKind.Array && ar.GetArrayLength() == 2 && ar[1].GetDouble() > 0)
                        item.Ratio = ar[0].GetDouble() / ar[1].GetDouble();
                    if (vi.TryGetProperty("variants", out var vars))
                    {
                        long best = -1;
                        foreach (var va in vars.EnumerateArray())
                        {
                            if (!va.TryGetProperty("content_type", out var ct) || ct.GetString() != "video/mp4") continue;
                            long br = va.TryGetProperty("bitrate", out var b) && b.TryGetInt64(out var bb) ? bb : 0;
                            if (br > best && va.TryGetProperty("url", out var vu)) { best = br; item.Video = vu.GetString(); }
                        }
                    }
                }
                var picture = m.TryGetProperty("media_url_https", out var mu2) ? mu2.GetString() : null;
                if (picture != null)
                {
                    // Photos at a size good for a card (X's "medium", up to 1200 px).
                    var src = item.Kind == "photo" && !picture.Contains('?') ? picture + "?name=medium" : picture;
                    try { item.Image = await DownloadImageAsync(src, url + key + "#m" + i); }
                    catch (Exception ex) { Log.Info("LinkPreviews media " + ex.Message); }
                }
                if (item.Image != null || item.Video != null) list.Add(item);
                i++;
            }
            if (list.Count > 0)
            {
                entry.Media = list;
                entry.Image = list[0].Image;
            }
        }
        if (user.TryGetProperty("profile_image_url_https", out var av) && av.GetString() is string avatar)
        {
            try { entry.Avatar = await DownloadImageAsync(avatar.Replace("_normal.", "_bigger."), url + key + "#avatar"); }
            catch (Exception ex) { Log.Info("LinkPreviews avatar " + ex.Message); }
        }
    }

    private static async Task<string> ReadLimitedStringAsync(HttpResponseMessage resp, int max)
    {
        await using var s = await resp.Content.ReadAsStreamAsync();
        var buf = new byte[max];
        int read = 0, n;
        while (read < max && (n = await s.ReadAsync(buf.AsMemory(read, max - read))) > 0) read += n;
        var charset = resp.Content.Headers.ContentType?.CharSet;
        Encoding enc;
        try { enc = string.IsNullOrWhiteSpace(charset) ? Encoding.UTF8 : Encoding.GetEncoding(charset.Trim('"')); }
        catch { enc = Encoding.UTF8; }
        return enc.GetString(buf, 0, read);
    }

    private async Task<string?> DownloadImageAsync(string imageUrl, string pageUrl)
    {
        if (!IsWebUrl(imageUrl, out _)) return null;
        using var resp = await Http.GetAsync(imageUrl, HttpCompletionOption.ResponseHeadersRead);
        if (!resp.IsSuccessStatusCode) return null;
        var type = resp.Content.Headers.ContentType?.MediaType ?? "";
        var ext = type switch
        {
            "image/jpeg" => ".jpg", "image/png" => ".png", "image/gif" => ".gif", "image/webp" => ".webp", "image/avif" => ".avif",
            _ => Path.GetExtension(new Uri(imageUrl).AbsolutePath).ToLowerInvariant() is var e && e is ".jpg" or ".jpeg" or ".png" or ".gif" or ".webp" ? e : null,
        };
        if (ext == null) return null;
        const int Max = 8 * 1024 * 1024;
        if (resp.Content.Headers.ContentLength is long len && len > Max) return null;
        await using var src = await resp.Content.ReadAsStreamAsync();
        using var ms = new MemoryStream();
        var buf = new byte[81920];
        int n;
        while ((n = await src.ReadAsync(buf)) > 0)
        {
            ms.Write(buf, 0, n);
            if (ms.Length > Max) return null;
        }
        Directory.CreateDirectory(_dir);
        var name = Hash(pageUrl) + ext;
        await File.WriteAllBytesAsync(Path.Combine(_dir, name), ms.ToArray());
        return name;
    }

    private static Dictionary<string, string> ParseMeta(string html)
    {
        var d = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var headEnd = html.IndexOf("</head>", StringComparison.OrdinalIgnoreCase);
        var head = headEnd > 0 ? html[..headEnd] : html;
        foreach (Match m in MetaRx.Matches(head))
        {
            string? key = null, content = null;
            foreach (Match a in AttrRx.Matches(m.Value))
            {
                var name = a.Groups[1].Value.ToLowerInvariant();
                var value = a.Groups[2].Success ? a.Groups[2].Value : a.Groups[3].Success ? a.Groups[3].Value : a.Groups[4].Value;
                if (name is "property" or "name" or "itemprop") key ??= value;
                else if (name == "content") content = value;
            }
            if (key != null && content != null && !d.ContainsKey(key)) d[key] = content;
        }
        return d;
    }

    private static string? First(Dictionary<string, string> meta, params string[] keys)
    {
        foreach (var k in keys)
            if (meta.TryGetValue(k, out var v) && Clean(v) is string c) return c;
        return null;
    }

    private static string? Clean(string? s)
    {
        if (string.IsNullOrWhiteSpace(s)) return null;
        var t = Regex.Replace(WebUtility.HtmlDecode(s), @"\s+", " ").Trim();
        return t.Length == 0 ? null : t.Length > 300 ? t[..300] : t;
    }
}
