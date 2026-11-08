using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Security.Cryptography;
using System.Text;

namespace MarkNotes.Storage;

/// <summary>
/// Small copies of big pictures for note cards, covers and canvases, cached in
/// %LOCALAPPDATA%\MarkNotes\thumbs, so a grid of hundreds of covers stays light.
/// JPEG, or PNG for pictures with transparency (which must stay transparent).
/// </summary>
public static class Thumbs
{
    // Half the cores (2…6): a folder of covers fills quickly without making typing stutter.
    private static readonly SemaphoreSlim Limit = new(Math.Clamp(Environment.ProcessorCount / 2, 2, 6));

    public static async Task<string> GetAsync(string abs, int width)
    {
        var fi = new FileInfo(abs);
        if (!fi.Exists) return abs;
        var ext = fi.Extension.ToLowerInvariant();
        if (ext is ".svg" or ".gif" or ".ico" or ".webp" or ".avif" || fi.Length < 120_000) return abs;
        width = Math.Clamp(width, 64, 1600);
        // "|a" (PNG): thumbnails made before transparency was kept had black backgrounds; those are made again.
        var key = Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes($"{abs.ToLowerInvariant()}|{fi.LastWriteTimeUtc.Ticks}|{fi.Length}|{width}{(ext == ".png" ? "|a" : "")}")))[..24];
        var dir = Path.Combine(AppPaths.LocalDir, "thumbs");
        var jpg = Path.Combine(dir, key + ".jpg");
        var png = Path.Combine(dir, key + ".png");
        if (File.Exists(jpg)) return jpg;
        if (File.Exists(png)) return png;
        await Limit.WaitAsync();
        try
        {
            if (File.Exists(jpg)) return jpg;
            if (File.Exists(png)) return png;
            return await Task.Run(() => Make(abs, dir, key, width));
        }
        finally { Limit.Release(); }
    }

    private static string Make(string abs, string dir, string key, int width)
    {
        try
        {
            using var src = Image.FromFile(abs);
            ApplyOrientation(src);
            if (src.Width <= width) return abs;
            int h = Math.Max(1, (int)Math.Round(src.Height * (double)width / src.Width));
            bool alpha = Image.IsAlphaPixelFormat(src.PixelFormat) ||
                         (src.Flags & ((int)ImageFlags.HasAlpha | (int)ImageFlags.HasTranslucent)) != 0;
            using var bmp = new Bitmap(width, h, alpha ? PixelFormat.Format32bppArgb : PixelFormat.Format24bppRgb);
            using (var g = Graphics.FromImage(bmp))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.SmoothingMode = SmoothingMode.HighQuality;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.CompositingQuality = CompositingQuality.HighQuality;
                g.Clear(alpha ? Color.Transparent : Color.Black);
                g.DrawImage(src, 0, 0, width, h);
            }
            Directory.CreateDirectory(dir);
            var target = Path.Combine(dir, key + (alpha ? ".png" : ".jpg"));
            var tmp = target + ".tmp";
            if (alpha) bmp.Save(tmp, ImageFormat.Png);
            else
            {
                var jpeg = ImageCodecInfo.GetImageEncoders().First(c => c.FormatID == ImageFormat.Jpeg.Guid);
                using var ps = new EncoderParameters(1);
                ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 84L);
                bmp.Save(tmp, jpeg, ps);
            }
            File.Move(tmp, target, true);
            return target;
        }
        catch (Exception ex)
        {
            Log.Error("Thumb " + abs, ex);
            return abs;
        }
    }

    /// <summary>Phones store rotation in EXIF; browsers honour it, so thumbnails must too.</summary>
    private static void ApplyOrientation(Image img)
    {
        const int OrientationId = 0x0112;
        if (!img.PropertyIdList.Contains(OrientationId)) return;
        var v = img.GetPropertyItem(OrientationId)?.Value;
        if (v == null || v.Length == 0) return;
        var flip = v[0] switch
        {
            2 => RotateFlipType.RotateNoneFlipX,
            3 => RotateFlipType.Rotate180FlipNone,
            4 => RotateFlipType.Rotate180FlipX,
            5 => RotateFlipType.Rotate90FlipX,
            6 => RotateFlipType.Rotate90FlipNone,
            7 => RotateFlipType.Rotate270FlipX,
            8 => RotateFlipType.Rotate270FlipNone,
            _ => RotateFlipType.RotateNoneFlipNone,
        };
        if (flip != RotateFlipType.RotateNoneFlipNone) img.RotateFlip(flip);
    }
}
