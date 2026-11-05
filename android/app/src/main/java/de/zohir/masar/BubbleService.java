package de.zohir.masar;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.style.RelativeSizeSpan;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

/** Floating "✓ delivered" bubble shown on top of Google Maps while driving a round. */
public class BubbleService extends Service {
    static final String ACTION_STOP = "de.zohir.masar.STOP";
    static final String ACTION_REFRESH = "de.zohir.masar.REFRESH";
    private static final String CHANNEL = "masar_drive";
    private static final int NOTIF_ID = 7;

    private WindowManager wm;
    private TextView bubble;
    private WindowManager.LayoutParams lp;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private long lastTap = 0;

    static void start(Context c) {
        Intent i = new Intent(c, BubbleService.class).setAction(ACTION_REFRESH);
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
    }

    static void stop(Context c) {
        c.stopService(new Intent(c, BubbleService.class));
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        goForeground("مَسار شغّال");
        if (Settings.canDrawOverlays(this)) addBubble();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (bubble == null && Settings.canDrawOverlays(this)) addBubble();
        refresh();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (bubble != null) {
            try { wm.removeView(bubble); } catch (Exception ignored) { }
            bubble = null;
        }
        super.onDestroy();
    }

    private int dp(float v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private void addBubble() {
        wm = (WindowManager) getSystemService(WINDOW_SERVICE);
        bubble = new TextView(this);
        bubble.setGravity(Gravity.CENTER);
        bubble.setTextColor(Color.WHITE);
        bubble.setTypeface(Typeface.DEFAULT_BOLD);
        bubble.setTextSize(13);
        bubble.setLineSpacing(0, 0.9f);
        GradientDrawable bg = new GradientDrawable();
        bg.setShape(GradientDrawable.OVAL);
        bg.setColor(Color.parseColor("#2BB673"));
        bg.setStroke(dp(3), Color.WHITE);
        bubble.setBackground(bg);
        bubble.setElevation(dp(8));

        int size = dp(76);
        lp = new WindowManager.LayoutParams(size, size,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.START;
        DisplayMetrics m = getResources().getDisplayMetrics();
        lp.x = m.widthPixels - size - dp(12);
        lp.y = Math.round(m.heightPixels * 0.42f);

        bubble.setOnTouchListener(new View.OnTouchListener() {
            float downX, downY; int startX, startY; long downAt; boolean moved; boolean longFired;
            final Runnable longPress = () -> { longFired = true; openApp(); };

            @Override public boolean onTouch(View v, MotionEvent e) {
                switch (e.getAction()) {
                    case MotionEvent.ACTION_DOWN:
                        downX = e.getRawX(); downY = e.getRawY();
                        startX = lp.x; startY = lp.y; downAt = System.currentTimeMillis();
                        moved = false; longFired = false;
                        ui.postDelayed(longPress, 700);
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        float dx = e.getRawX() - downX, dy = e.getRawY() - downY;
                        if (!moved && Math.hypot(dx, dy) > dp(10)) { moved = true; ui.removeCallbacks(longPress); }
                        if (moved) {
                            lp.x = startX + Math.round(dx); lp.y = startY + Math.round(dy);
                            try { wm.updateViewLayout(bubble, lp); } catch (Exception ignored) { }
                        }
                        return true;
                    case MotionEvent.ACTION_UP:
                        ui.removeCallbacks(longPress);
                        if (!moved && !longFired) onTap();
                        return true;
                    case MotionEvent.ACTION_CANCEL:
                        ui.removeCallbacks(longPress);
                        return true;
                }
                return false;
            }
        });

        try { wm.addView(bubble, lp); } catch (Exception e) { bubble = null; }
    }

    /** Tap on the bubble: mark the current stop delivered and start navigation to the next one. */
    private void onTap() {
        long now = System.currentTimeMillis();
        if (now - lastTap < 1500) return; // ignore accidental double taps
        lastTap = now;

        JSONObject d = Drive.load(this);
        if (d == null) { stopSelf(); return; }
        int cur = Drive.current(d);
        if (cur < 0) { openApp(); return; }

        String doneLabel = Drive.stop(d, cur).optString("label");
        Drive.mark(d, "done");
        Drive.save(this, d);
        refresh();

        int next = Drive.current(d);
        if (next >= 0) {
            JSONObject s = Drive.stop(d, next);
            Toast.makeText(this, "✓ " + doneLabel + "\nالتالي (" + (next + 1) + "): " + s.optString("label"), Toast.LENGTH_LONG).show();
            Drive.navigate(this, s.optDouble("lat"), s.optDouble("lon"));
        } else {
            Toast.makeText(this, "🎉 خلصت الجولة! اضغط الفقاعة لتفتح مَسار", Toast.LENGTH_LONG).show();
            JSONObject start = d.optJSONObject("start");
            if (d.optBoolean("roundtrip") && start != null) {
                Drive.navigate(this, start.optDouble("lat"), start.optDouble("lon"));
            }
        }
    }

    private void openApp() {
        Intent i = new Intent(this, MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        startActivity(i);
    }

    private void refresh() {
        JSONObject d = Drive.load(this);
        int cur = Drive.current(d), total = Drive.total(d);
        String big, small, title;
        if (d == null) { big = "✓"; small = ""; title = "مَسار"; }
        else if (cur >= 0) {
            big = "✓"; small = (cur + 1) + "/" + total;
            title = "المحطة " + (cur + 1) + " من " + total + ": " + Drive.stop(d, cur).optString("label");
        } else { big = "🏁"; small = "تم"; title = "خلصت الجولة 🎉"; }

        if (bubble != null) {
            SpannableString t = new SpannableString(big + "\n" + small);
            t.setSpan(new RelativeSizeSpan(2.2f), 0, big.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            bubble.setText(t);
        }
        goForeground(title);
    }

    private void goForeground(String title) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "الجولة", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        PendingIntent open = PendingIntent.getActivity(this, 1,
                new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent stop = PendingIntent.getService(this, 2,
                new Intent(this, BubbleService.class).setAction(ACTION_STOP),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_menu_mylocation)
                .setContentTitle(title)
                .setContentText("اضغط الفقاعة الخضراء بعد كل توصيل")
                .setContentIntent(open)
                .setOngoing(true)
                .addAction(new Notification.Action.Builder(null, "إخفاء الفقاعة", stop).build())
                .build();
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIF_ID, n);
        }
    }
}
