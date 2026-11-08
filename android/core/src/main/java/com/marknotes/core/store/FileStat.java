package com.marknotes.core.store;

import java.io.IOException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.List;

/**
 * A file or folder with what listings need, read in one stat (the PC's FileInfo from a directory listing).
 * Times always come from java.nio (millisecond precision everywhere; java.io.File.lastModified may round to
 * seconds on Android, which would break the save-conflict check).
 */
final class FileStat {
    final String path;
    final String name;
    final boolean dir;
    final long size;
    final long mtime;
    final long ctime;

    private FileStat(String path, String name, BasicFileAttributes a) {
        this.path = path;
        this.name = name;
        this.dir = a.isDirectory();
        this.size = a.isDirectory() ? 0 : a.size();
        this.mtime = a.lastModifiedTime().toMillis();
        long c = 0;
        try {
            c = a.creationTime().toMillis();
        } catch (RuntimeException ignored) {
        }
        this.ctime = c;
    }

    /** The file or folder at path, or null when there is none. */
    static FileStat of(String path) {
        try {
            return new FileStat(path, PathUtil.fileName(path), Files.readAttributes(Paths.get(path), BasicFileAttributes.class));
        } catch (IOException | RuntimeException e) {
            return null;
        }
    }

    /** Entries of a folder in the order NTFS lists them (so walks give the same order as on the PC). */
    static List<FileStat> list(String dir) throws IOException {
        List<FileStat> out = new ArrayList<>();
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(Paths.get(dir))) {
            for (Path p : ds) {
                String name = p.getFileName().toString();
                try {
                    out.add(new FileStat(PathUtil.combine(dir, name), name, Files.readAttributes(p, BasicFileAttributes.class)));
                } catch (IOException | RuntimeException ignored) {
                    // gone meanwhile, or a broken link
                }
            }
        } catch (RuntimeException e) {
            throw new IOException(e.getMessage(), e);
        }
        out.sort((a, b) -> NameOrder.NTFS.compare(a.name, b.name));
        return out;
    }
}
