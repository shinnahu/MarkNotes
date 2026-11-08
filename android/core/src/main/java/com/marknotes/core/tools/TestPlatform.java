package com.marknotes.core.tools;

import com.marknotes.core.Platform;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.stream.Stream;

/**
 * A Platform for tests: everything lives in one temp folder (notes, config, cache, trash), "trash" moves into that
 * temp trash folder, and messages for the interface are queued for the test to read.
 */
public final class TestPlatform implements Platform {
    private final File base;
    private final File notes;
    private final File config;
    private final File cache;
    private final File trash;
    public final LinkedBlockingQueue<String> posted = new LinkedBlockingQueue<>();
    private int trashed;

    public TestPlatform(File base) throws IOException {
        this.base = base;
        this.notes = new File(base, "notes");
        this.config = new File(base, "config");
        this.cache = new File(base, "cache");
        this.trash = new File(base, "trash");
        for (File d : new File[] {notes, config, cache, trash}) {
            if (!d.isDirectory() && !d.mkdirs()) throw new IOException("Could not create " + d);
        }
    }

    /** A new, empty temp folder. */
    public static TestPlatform temp() throws IOException {
        return new TestPlatform(Files.createTempDirectory("marknotes-selftest-").toFile());
    }

    public File base() {
        return base;
    }

    public File trashDir() {
        return trash;
    }

    @Override
    public void postToUi(String json) {
        posted.add(json);
    }

    @Override
    public File notesRoot() {
        return notes;
    }

    @Override
    public File configDir() {
        return config;
    }

    @Override
    public File cacheDir() {
        return cache;
    }

    @Override
    public synchronized void trash(File f) throws IOException {
        if (!f.exists()) return;
        File dest;
        do {
            dest = new File(trash, (++trashed) + "-" + f.getName());
        } while (dest.exists());
        Files.move(f.toPath(), dest.toPath());
    }

    @Override
    public String deviceName() {
        return "Self-test";
    }

    @Override
    public String deviceModel() {
        return "JVM";
    }

    @Override
    public String platformName() {
        return "selftest";
    }

    /** Deletes the whole temp folder. */
    public void deleteAll() {
        try (Stream<Path> s = Files.walk(base.toPath())) {
            s.sorted(Comparator.reverseOrder()).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (IOException ignored) {
                }
            });
        } catch (IOException ignored) {
        }
    }
}
