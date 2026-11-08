package com.marknotes.core.store;

import java.util.AbstractMap;
import java.util.AbstractSet;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * A string-keyed map that ignores case like the PC's {@code Dictionary(StringComparer.OrdinalIgnoreCase)}: lookups
 * match any case, a put on an existing key keeps the key's first spelling, and entries keep insertion order (so
 * files written from it list their keys like the PC's). Not thread-safe.
 */
public final class CiMap<V> extends AbstractMap<String, V> {
    private final LinkedHashMap<String, V> data = new LinkedHashMap<>();
    /** folded key → key as stored. */
    private final HashMap<String, String> keys = new HashMap<>();

    public CiMap() {}

    public CiMap(Map<String, ? extends V> m) {
        for (Map.Entry<String, ? extends V> e : m.entrySet()) put(e.getKey(), e.getValue());
    }

    /** Per-character simple upper case (what OrdinalIgnoreCase compares). */
    static String fold(String k) {
        int n = k.length();
        for (int i = 0; i < n; i++) {
            char c = k.charAt(i);
            if (Character.toUpperCase(c) != c) {
                char[] a = k.toCharArray();
                for (int j = i; j < n; j++) a[j] = Character.toUpperCase(a[j]);
                return new String(a);
            }
        }
        return k;
    }

    @Override
    public V get(Object k) {
        if (!(k instanceof String)) return null;
        String o = keys.get(fold((String) k));
        return o == null ? null : data.get(o);
    }

    @Override
    public boolean containsKey(Object k) {
        return k instanceof String && keys.containsKey(fold((String) k));
    }

    @Override
    public V put(String k, V v) {
        String f = fold(k);
        String o = keys.get(f);
        if (o != null) return data.put(o, v);
        keys.put(f, k);
        return data.put(k, v);
    }

    @Override
    public V remove(Object k) {
        if (!(k instanceof String)) return null;
        String o = keys.remove(fold((String) k));
        return o == null ? null : data.remove(o);
    }

    @Override
    public void clear() {
        data.clear();
        keys.clear();
    }

    @Override
    public int size() {
        return data.size();
    }

    /** The key as it is stored (its first spelling), or null. */
    public String storedKey(String k) {
        return keys.get(fold(k));
    }

    /** A copy of the keys, in order (safe to modify the map while going through it). */
    public List<String> keyList() {
        return new ArrayList<>(data.keySet());
    }

    @Override
    public Set<Map.Entry<String, V>> entrySet() {
        return new AbstractSet<Map.Entry<String, V>>() {
            @Override
            public int size() {
                return data.size();
            }

            @Override
            public Iterator<Map.Entry<String, V>> iterator() {
                final Iterator<Map.Entry<String, V>> it = data.entrySet().iterator();
                return new Iterator<Map.Entry<String, V>>() {
                    Map.Entry<String, V> last;

                    @Override
                    public boolean hasNext() {
                        return it.hasNext();
                    }

                    @Override
                    public Map.Entry<String, V> next() {
                        return last = it.next();
                    }

                    @Override
                    public void remove() {
                        String k = last.getKey();
                        it.remove();
                        keys.remove(fold(k));
                    }
                };
            }
        };
    }
}
