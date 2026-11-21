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
        /// <summary>
        /// X's embed data had only the first part of the post's text (long posts), and its page on x.com
        /// could not be read yet. Null for posts kept before 2.5.2: checked when the cache loads.
        /// </summary>
        public bool? Cut { get; set; }
        /// <summary>When to try reading the whole text again (unix ms) after the post's page could not be read.</summary>
        public long CutRetry { get; set; }
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
        /// <summary>The picture's address on X (pbs.twimg.com), for its large version. Null for posts kept before 2.5.2.</summary>
        public string? Url { get; set; }
        /// <summary>X's large version of a photo, downloaded the first time it is opened and kept in the cache folder.</summary>
        public string? Large { get; set; }
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
    private readonly ConcurrentDictionary<string, Task> _completing = new();
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
                        if (e.Kind == "tweet" && !e.Failed)
                        {
                            // Before 2.5.2 long posts were kept with X's first 280 characters only: the ones that
                            // look cut get their whole text the next time a note shows them.
                            e.Cut ??= LooksCut(e.Text);
                            if (e.Quote != null) e.Quote.Cut ??= LooksCut(e.Quote.Text);
                        }
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
            {
                if (m.Image != null) yield return m.Image;
                if (m.Large != null) yield return m.Large;
            }
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
        Entry? cut = null;
        lock (_gate)
        {
            if (Entries().TryGetValue(url, out var e) && !(IsTweet(url) && e.Kind != "tweet"))
            {
                // Failed lookups are retried: soon when the site could not be reached, after a day otherwise.
                var age = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - e.Fetched;
                if (!e.Failed || age < (e.Transient ? 90_000 : 86_400_000))
                {
                    if (doc.Length > 0 && e.Refs.Add(doc)) SaveSoon();
                    if (!TextDue(e)) return Dto(e);
                    cut = e;
                }
            }
        }
        if (cut is Entry kept)
        {
            // A long post kept with the first part of its text: the rest is read now, then the card shows it all.
            await _completing.GetOrAdd(url, _ => Task.Run(() => CompleteTextAsync(kept, gated: false)));
            _completing.TryRemove(url, out _);
            lock (_gate)
            {
                SaveSoon();
                return Dto(kept);
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

    /// <summary>
    /// The file of X's large version of picture <paramref name="index"/> of a saved post (or of the post it quotes):
    /// downloaded the first time and kept with the post. When X no longer has it, the saved picture (X's medium
    /// size) instead, with Fallback set. Null when the post has no such photo saved.
    /// </summary>
    public async Task<(string? Path, bool Fallback)> LargePictureAsync(string url, bool quote, int index)
    {
        url = url.Trim();
        MediaItem? m;
        lock (_gate)
        {
            Entries().TryGetValue(url, out var entry);
            var e = quote ? entry?.Quote : entry;
            m = e?.Media != null && index >= 0 && index < e.Media.Count ? e.Media[index] : null;
            if (m == null || m.Kind != "photo") return (null, false);
            if (m.Large != null && File.Exists(Path.Combine(_dir, m.Large))) return (Path.Combine(_dir, m.Large), false);
        }
        try
        {
            var src = m.Url ?? await FindPictureUrlAsync(url, quote, index);
            // Named like X names it (HXhDFa4W4AAJZaF.jpg), which is what the picture program shows and saves as.
            var xName = src == null ? null : Path.GetFileNameWithoutExtension(new Uri(src.Split('?')[0]).AbsolutePath);
            if (xName != null && !Regex.IsMatch(xName, @"^[A-Za-z0-9_-]{5,64}$")) xName = null;
            if (src != null && await DownloadImageAsync(LargeUrl(src), url + (quote ? "#q" : "") + "#m" + index + "#large", xName) is string large)
            {
                lock (_gate)
                {
                    m.Url ??= src;
                    m.Large = large;
                    SaveSoon();
                }
                return (Path.Combine(_dir, large), false);
            }
        }
        catch (Exception ex) { Log.Info($"LinkPreviews large picture {url}: {ex.Message}"); }
        var saved = m.Image != null ? Path.Combine(_dir, m.Image) : null;
        return saved != null && File.Exists(saved) ? (saved, true) : (null, false);
    }

    /// <summary>X's large size of a picture: https://pbs.twimg.com/media/ID?format=jpg&amp;name=large.</summary>
    private static string LargeUrl(string src)
    {
        var bare = src.Split('?')[0];
        var ext = Path.GetExtension(new Uri(bare).AbsolutePath).TrimStart('.').ToLowerInvariant();
        return ext.Length > 0 ? bare[..^(ext.Length + 1)] + "?format=" + ext + "&name=large" : bare + "?name=large";
    }

    /// <summary>
    /// The address of a picture of a post kept before 2.5.2 (they didn't keep it), read from X's embed data again.
    /// Null when X no longer has the post.
    /// </summary>
    private static async Task<string?> FindPictureUrlAsync(string url, bool quote, int index)
    {
        var tw = TweetRx.Match(url);
        if (!tw.Success) return null;
        var id = tw.Groups[1].Value;
        using var resp = await Http.GetAsync($"https://cdn.syndication.twimg.com/tweet-result?id={id}&lang=en&token={SyndicationToken(id)}");
        if (!resp.IsSuccessStatusCode) return null;
        using var d = JsonDocument.Parse(await resp.Content.ReadAsStringAsync());
        var post = d.RootElement;
        if (quote)
        {
            if (!post.TryGetProperty("quoted_tweet", out var q) || q.ValueKind != JsonValueKind.Object) return null;
            post = q;
        }
        if (!post.TryGetProperty("mediaDetails", out var media) || media.ValueKind != JsonValueKind.Array) return null;
        // The same pictures in the same order as when the post was saved (its first four).
        var list = media.EnumerateArray().Take(4).ToList();
        if (index >= list.Count) return null;
        var m = list[index];
        var type = m.TryGetProperty("type", out var ty) ? ty.GetString() : "photo";
        return type == "photo" && m.TryGetProperty("media_url_https", out var mu) ? mu.GetString() : null;
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
        // A long post (X Premium) comes with the first 280 characters of its text only, marked by "note_tweet".
        entry.Cut = root.TryGetProperty("note_tweet", out var note) && note.ValueKind == JsonValueKind.Object;
        if (root.TryGetProperty("quoted_tweet", out var q) && q.ValueKind == JsonValueKind.Object && q.TryGetProperty("user", out _))
        {
            var quote = new Entry { Kind = "tweet", Site = "X", Fetched = entry.Fetched };
            await ReadTweetAsync(quote, q, url, "#q");
            var qid = q.TryGetProperty("id_str", out var qi) ? qi.GetString() : null;
            quote.Url = qid != null && quote.Handle != null ? $"https://x.com/{quote.Handle}/status/{qid}" : url;
            // The quoted post has no such mark here: one that fills the 280 characters may go on.
            quote.Cut = LooksCut(quote.Text);
            entry.Quote = quote;
        }
        if (entry.Cut == true || entry.Quote?.Cut == true) await CompleteTextAsync(entry, gated: true);
    }

    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    /// <summary>A post kept with the first part of its text (or of the post it quotes) that is due for another try.</summary>
    private static bool TextDue(Entry e) => e.Kind == "tweet" && (e.Cut == true || e.Quote?.Cut == true) && Now >= e.CutRetry;

    private static readonly Regex AnyUrlRx = new(@"https?://\S+", RegexOptions.Compiled);

    /// <summary>
    /// Whether a post's text fills X's 280 characters, so it may be the start of a longer post
    /// (X counts most letters as 1, CJK characters and emoji as 2, and any link as 23).
    /// </summary>
    private static bool LooksCut(string? text)
    {
        if (string.IsNullOrEmpty(text)) return false;
        int weight = AnyUrlRx.Matches(text).Count * 23;
        foreach (var r in AnyUrlRx.Replace(text, "").EnumerateRunes())
        {
            int c = r.Value;
            weight += c <= 4351 || (c >= 8192 && c <= 8205) || (c >= 8208 && c <= 8223) || (c >= 8242 && c <= 8247) ? 1 : 2;
        }
        return weight >= 250;
    }

    /// <summary>
    /// X's embed data holds only the first 280 characters of a long post, and of a long post it quotes. The post's
    /// own page on x.com carries the whole text in its data, so a cut text is completed from there (once per post).
    /// Only the text changes: a post X no longer shows (deleted, hidden) keeps everything that was saved, and is
    /// not asked again. When x.com can't be reached, it is tried again later.
    /// </summary>
    private async Task CompleteTextAsync(Entry entry, bool gated)
    {
        var id = TweetRx.Match(entry.Url) is { Success: true } m ? m.Groups[1].Value : null;
        if (id == null) return;
        var quote = entry.Quote;
        var quoteId = quote?.Url is string qu && TweetRx.Match(qu) is { Success: true } qm ? qm.Groups[1].Value : null;
        if (!gated) await FetchGate.WaitAsync();
        try
        {
            var (posts, retryAt) = await TryReadPostPageAsync(entry.Handle, id);
            // The quoted post has a page of its own, in case the first one did not include it.
            Dictionary<string, PagePost>? quotePosts = posts;
            if (posts != null && quote?.Cut == true && quoteId != null && !posts.ContainsKey(quoteId))
            {
                (quotePosts, var quoteRetry) = await TryReadPostPageAsync(quote.Handle, quoteId);
                retryAt = Math.Max(retryAt, quoteRetry);
            }
            lock (_gate)
            {
                if (posts != null && entry.Cut == true) Complete(entry, id, posts, quotes: entry.Quote != null);
                if (quotePosts != null && quote?.Cut == true && quoteId != null) Complete(quote, quoteId, quotePosts, quotes: false);
                entry.CutRetry = entry.Cut == true || quote?.Cut == true ? retryAt : 0;
            }
        }
        finally
        {
            if (!gated) FetchGate.Release();
        }
    }

    /// <summary>
    /// The whole text of post <paramref name="id"/> from the posts of its page. A post the page doesn't have
    /// (deleted, or shown only after logging in) keeps the text it has: either way it is not asked again.
    /// </summary>
    private static void Complete(Entry e, string id, Dictionary<string, PagePost> posts, bool quotes)
    {
        // A post with no long text on its page was whole already.
        if (posts.TryGetValue(id, out var p) && !string.IsNullOrWhiteSpace(p.Note))
            SetText(e, CleanText(p.Note, p.Links, Array.Empty<string>(), quotes));
        e.Cut = false;
    }

    /// <summary>
    /// The posts of a post's page: none when X says the post is not there (404), null when x.com could not be
    /// asked (retryAt says when to try again: soon when offline, tomorrow otherwise).
    /// </summary>
    private static async Task<(Dictionary<string, PagePost>? Posts, long RetryAt)> TryReadPostPageAsync(string? handle, string id)
    {
        try { return (await ReadPostPageAsync(handle, id), 0); }
        catch (HttpRequestException ex) when (ex.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Gone)
        {
            return (new Dictionary<string, PagePost>(), 0);
        }
        catch (Exception ex)
        {
            Log.Info($"LinkPreviews text {id}: {ex.Message}");
            return (null, Now + (IsTransient(ex) ? 120_000 : 86_400_000));
        }
    }

    /// <summary>A post found in the data of an x.com page: its long text (null when it has none) and its links.</summary>
    private sealed record PagePost(string? Note, List<(string Short, string? Expanded)> Links);

    private static readonly Regex HandleRx = new(@"^[A-Za-z0-9_]{1,50}$", RegexOptions.Compiled);

    /// <summary>The posts in the data of a post's page on x.com (the post, the one it quotes, replies), by id.</summary>
    private static async Task<Dictionary<string, PagePost>> ReadPostPageAsync(string? handle, string id)
    {
        var who = handle != null && HandleRx.IsMatch(handle) ? handle : "i";
        using var resp = await Http.GetAsync($"https://x.com/{who}/status/{id}", HttpCompletionOption.ResponseHeadersRead);
        resp.EnsureSuccessStatusCode();
        var html = await ReadLimitedStringAsync(resp, 3_000_000);
        var posts = new Dictionary<string, PagePost>(StringComparer.Ordinal);
        // The page keeps X's post data as JSON inside script strings: "{\"data\":{...}}".
        const string Start = "\"{\\\"data\\\":";
        for (int at = html.IndexOf(Start, StringComparison.Ordinal); at >= 0; at = html.IndexOf(Start, at + 1, StringComparison.Ordinal))
        {
            var json = JsString(html, at, out var end);
            if (json == null) continue;
            at = end;
            try
            {
                using var d = JsonDocument.Parse(json);
                CollectPosts(d.RootElement, posts, 0);
            }
            catch (JsonException) { }
        }
        return posts;
    }

    private static JsonElement? Child(JsonElement el, string name) =>
        el.ValueKind == JsonValueKind.Object && el.TryGetProperty(name, out var v) ? v : null;

    /// <summary>Walks X's post data for posts (by id) and the long text of the ones that have it.</summary>
    private static void CollectPosts(JsonElement el, Dictionary<string, PagePost> posts, int depth)
    {
        if (depth > 80) return;
        if (el.ValueKind == JsonValueKind.Array)
        {
            foreach (var x in el.EnumerateArray()) CollectPosts(x, posts, depth + 1);
            return;
        }
        if (el.ValueKind != JsonValueKind.Object) return;
        var type = Child(el, "__typename") is { ValueKind: JsonValueKind.String } tn ? tn.GetString() : null;
        if (Child(el, "rest_id") is { ValueKind: JsonValueKind.String } rid && rid.GetString() is string id &&
            (type == "Tweet" || (type == null && Child(el, "edit_control") != null)))
        {
            string? text = null;
            var links = new List<(string Short, string? Expanded)>();
            if (Child(el, "note_tweet") is JsonElement nt && Child(nt, "note_tweet_results") is JsonElement nr && Child(nr, "result") is JsonElement res)
            {
                text = Child(res, "text") is { ValueKind: JsonValueKind.String } tx ? tx.GetString() : null;
                if (Child(res, "entity_set") is JsonElement es && Child(es, "urls") is { ValueKind: JsonValueKind.Array } us) links.AddRange(UrlEntities(us));
            }
            if (!posts.TryGetValue(id, out var known) || (known.Note == null && text != null)) posts[id] = new PagePost(text, links);
        }
        foreach (var p in el.EnumerateObject()) CollectPosts(p.Value, posts, depth + 1);
    }

    private static bool IsHex(string s, int start, int count)
    {
        if (start + count > s.Length) return false;
        for (int i = start; i < start + count; i++)
            if (!Uri.IsHexDigit(s[i])) return false;
        return true;
    }

    /// <summary>The value of the JavaScript string literal that opens at <paramref name="at"/> (a double quote), or null.</summary>
    private static string? JsString(string s, int at, out int end)
    {
        end = at;
        var sb = new StringBuilder();
        for (int i = at + 1; i < s.Length; i++)
        {
            char c = s[i];
            if (c == '"') { end = i; return sb.ToString(); }
            if (c != '\\') { sb.Append(c); continue; }
            if (++i >= s.Length) return null;
            c = s[i];
            switch (c)
            {
                case 'n': sb.Append('\n'); break;
                case 'r': sb.Append('\r'); break;
                case 't': sb.Append('\t'); break;
                case 'b': sb.Append('\b'); break;
                case 'f': sb.Append('\f'); break;
                case 'v': sb.Append('\v'); break;
                case '0': sb.Append('\0'); break;
                case '\r': if (i + 1 < s.Length && s[i + 1] == '\n') i++; break; // a line continuation
                case (char)0x0A or (char)0x2028 or (char)0x2029: break; // a line continuation too
                case 'x' when IsHex(s, i + 1, 2):
                    sb.Append((char)Convert.ToInt32(s.Substring(i + 1, 2), 16));
                    i += 2;
                    break;
                case 'u' when i + 1 < s.Length && s[i + 1] == '{':
                    {
                        int close = s.IndexOf('}', i + 2);
                        if (close < 0 || close - (i + 2) is < 1 or > 6 || !IsHex(s, i + 2, close - (i + 2))) return null;
                        int cp = Convert.ToInt32(s.Substring(i + 2, close - (i + 2)), 16);
                        if (cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return null;
                        sb.Append(char.ConvertFromUtf32(cp));
                        i = close;
                        break;
                    }
                case 'u' when IsHex(s, i + 1, 4):
                    sb.Append((char)Convert.ToInt32(s.Substring(i + 1, 4), 16));
                    i += 4;
                    break;
                default: sb.Append(c); break;
            }
        }
        return null;
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
        var links = new List<(string Short, string? Expanded)>();
        var mediaLinks = new List<string>();
        if (tw.TryGetProperty("entities", out var ents))
        {
            if (ents.TryGetProperty("urls", out var urls) && urls.ValueKind == JsonValueKind.Array) links.AddRange(UrlEntities(urls));
            if (ents.TryGetProperty("media", out var em) && em.ValueKind == JsonValueKind.Array)
                foreach (var m in em.EnumerateArray())
                    if (m.TryGetProperty("url", out var mu) && mu.GetString() is string s && s.Length > 0) mediaLinks.Add(s);
        }
        SetText(entry, CleanText(text, links, mediaLinks, quotes: tw.TryGetProperty("quoted_tweet", out _)));
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
                item.Url = picture;
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

    /// <summary>The (t.co address, real address) pairs of a post's links.</summary>
    private static List<(string Short, string? Expanded)> UrlEntities(JsonElement urls)
    {
        var list = new List<(string Short, string? Expanded)>();
        foreach (var u in urls.EnumerateArray())
        {
            if (u.ValueKind != JsonValueKind.Object) continue;
            var shortUrl = u.TryGetProperty("url", out var su) && su.ValueKind == JsonValueKind.String ? su.GetString() : null;
            if (string.IsNullOrEmpty(shortUrl)) continue;
            list.Add((shortUrl, u.TryGetProperty("expanded_url", out var eu) && eu.ValueKind == JsonValueKind.String ? eu.GetString() : null));
        }
        return list;
    }

    /// <summary>
    /// A post's text as the card shows it: short t.co links become the real addresses; the ones pointing at the
    /// media, or at the quoted post (<paramref name="quotes"/>), go away.
    /// </summary>
    private static string CleanText(string text, IEnumerable<(string Short, string? Expanded)> links, IEnumerable<string> mediaLinks, bool quotes)
    {
        foreach (var (shortUrl, expanded) in links)
        {
            var isQuote = quotes && expanded != null && TweetRx.IsMatch(expanded);
            text = text.Replace(shortUrl, isQuote ? "" : expanded ?? shortUrl);
        }
        foreach (var m in mediaLinks) text = text.Replace(m, "");
        text = WebUtility.HtmlDecode(text);
        return Regex.Replace(text, @"(\s*https://t\.co/\w+)+\s*$", "").Trim();
    }

    private static void SetText(Entry entry, string text)
    {
        entry.Text = text;
        entry.Title = text.Length > 0 ? (text.Length > 140 ? text[..140] + "…" : text) : entry.Author;
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

    /// <summary>Downloads a picture into the cache folder, named after <paramref name="pageUrl"/> (hashed) or <paramref name="fileName"/>.</summary>
    private async Task<string?> DownloadImageAsync(string imageUrl, string pageUrl, string? fileName = null)
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
        var name = (fileName ?? Hash(pageUrl)) + ext;
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
