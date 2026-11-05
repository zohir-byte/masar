package de.zohir.masar;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Locale;

/** The current delivery round, shared between the web page and the floating bubble. */
final class Drive {
    private static final String PREFS = "masar";
    private static final String KEY = "drive";

    static JSONObject load(Context c) {
        String s = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null);
        if (s == null) return null;
        try { return new JSONObject(s); } catch (Exception e) { return null; }
    }

    static String loadRaw(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, "null");
    }

    static void save(Context c, String json) {
        SharedPreferences.Editor e = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        if (json == null || "null".equals(json)) e.remove(KEY); else e.putString(KEY, json);
        e.apply();
    }

    static void save(Context c, JSONObject d) { save(c, d == null ? null : d.toString()); }

    /** Index of the first stop that is neither done nor skipped, or -1 when the round is finished. */
    static int current(JSONObject d) {
        if (d == null) return -1;
        JSONArray stops = d.optJSONArray("stops");
        JSONObject status = d.optJSONObject("status");
        if (stops == null) return -1;
        for (int i = 0; i < stops.length(); i++) {
            JSONObject s = stops.optJSONObject(i);
            if (s == null) continue;
            if (status == null || !status.has(s.optString("id"))) return i;
        }
        return -1;
    }

    static int total(JSONObject d) {
        JSONArray stops = d == null ? null : d.optJSONArray("stops");
        return stops == null ? 0 : stops.length();
    }

    static JSONObject stop(JSONObject d, int i) {
        JSONArray stops = d.optJSONArray("stops");
        return stops == null ? null : stops.optJSONObject(i);
    }

    /** Marks the current stop ("done" or "skip"). Returns false if nothing was left. */
    static boolean mark(JSONObject d, String st) {
        int i = current(d);
        if (i < 0) return false;
        try {
            String id = stop(d, i).optString("id");
            JSONObject status = d.optJSONObject("status");
            if (status == null) { status = new JSONObject(); d.put("status", status); }
            status.put(id, st);
            JSONArray h = d.optJSONArray("history");
            if (h == null) { h = new JSONArray(); d.put("history", h); }
            h.put(id);
            d.put("updated", System.currentTimeMillis());
            return true;
        } catch (Exception e) { return false; }
    }

    /** Opens turn-by-turn driving navigation in Google Maps. */
    static void navigate(Context c, double lat, double lon) {
        String ll = String.format(Locale.US, "%.6f,%.6f", lat, lon);
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse("google.navigation:q=" + ll + "&mode=d"));
        i.setPackage("com.google.android.apps.maps");
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            c.startActivity(i);
        } catch (ActivityNotFoundException e) {
            Intent w = new Intent(Intent.ACTION_VIEW, Uri.parse(
                    "https://www.google.com/maps/dir/?api=1&travelmode=driving&dir_action=navigate&destination=" + ll));
            w.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try { c.startActivity(w); } catch (Exception ignored) { }
        }
    }

    private Drive() { }
}
