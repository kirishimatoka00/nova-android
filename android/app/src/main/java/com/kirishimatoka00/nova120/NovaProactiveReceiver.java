package com.kirishimatoka00.nova120;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * v2.6.101：AI 主動說話——鬧鐘到點／開機後的接收器。
 * 到點：goAsync() 後在背景執行緒呼叫 Gemini 並發通知（廣播約 10 秒內必須結束，所以 deadline 設 9 秒）；做完再排下一個。
 * 開機／App 更新：只重新排程。
 */
public class NovaProactiveReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(final Context context, Intent intent) {
        final String action = intent == null ? null : intent.getAction();
        final Context app = context.getApplicationContext();
        if (NovaProactive.ACTION_FIRE.equals(action)) {
            final PendingResult pr = goAsync();
            new Thread(new Runnable() {
                @Override public void run() {
                    try {
                        NovaProactive.runDue(app, System.currentTimeMillis() + 9000L);
                    } catch (Throwable t) {
                        // 任何錯誤都不能讓廣播卡住
                    } finally {
                        try { NovaProactive.schedule(app); } catch (Throwable t) { /* ignore */ }
                        pr.finish();
                    }
                }
            }, "nova-proactive").start();
        } else {
            // BOOT_COMPLETED／MY_PACKAGE_REPLACED
            try { NovaProactive.schedule(app); } catch (Throwable t) { /* ignore */ }
        }
    }
}
