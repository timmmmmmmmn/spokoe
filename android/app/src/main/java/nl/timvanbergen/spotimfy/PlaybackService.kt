package nl.timvanbergen.spotimfy

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.media.app.NotificationCompat.MediaStyle
import org.json.JSONObject
import java.net.URL

/**
 * Speelt op de achtergrond: houdt de app in leven zolang er muziek is, en toont de mediamelding
 * (vergrendelscherm, snelle instellingen, Bluetooth, koptelefoonknoppen) via een MediaSession.
 */
class PlaybackService : Service() {

    private lateinit var session: MediaSessionCompat
    private var title = ""
    private var artist = ""
    private var album = ""
    private var duration = 0L
    private var cover: Bitmap? = null
    private var coverUrl = ""
    private var playing = false
    private var position = 0L
    private var foreground = false

    private val listener: (JSONObject, String) -> Unit = { msg, _ -> onEvent(msg) }

    override fun onCreate() {
        super.onCreate()
        Core.ensure(this)
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Afspelen", NotificationManager.IMPORTANCE_LOW).apply {
            setShowBadge(false)
        })
        session = MediaSessionCompat(this, "Spotimfy").apply {
            setCallback(object : MediaSessionCompat.Callback() {
                override fun onPlay() = Core.cmd("resume")
                override fun onPause() = Core.cmd("pause")
                override fun onSkipToNext() = Core.cmd("next")
                override fun onSkipToPrevious() = Core.cmd("prev")
                override fun onSeekTo(pos: Long) = Core.cmd("seek", mapOf("ms" to pos))
                override fun onStop() = Core.cmd("pause")
            })
            setSessionActivity(openApp())
            isActive = true
        }
        Core.listen(listener)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Android wil binnen een paar seconden een melding zien van een voorgronddienst.
        goForeground()
        // Knoppen in de melding en op de koptelefoon komen hier binnen.
        androidx.media.session.MediaButtonReceiver.handleIntent(session, intent)
        return START_STICKY
    }

    private fun openApp(): PendingIntent = PendingIntent.getActivity(
        this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )

    private fun onEvent(m: JSONObject) {
        when (m.optString("type")) {
            "track" -> {
                title = m.optString("name")
                val artists = m.optJSONArray("artists")
                artist = (0 until (artists?.length() ?: 0)).joinToString(", ") { artists!!.getJSONObject(it).optString("name") }
                album = m.optString("album")
                duration = m.optLong("duration")
                position = 0
                val url = m.optString("cover")
                if (url != coverUrl) {
                    coverUrl = url
                    cover = null
                    if (url.isNotEmpty()) Thread {
                        val bmp = try { URL(url).openStream().use { BitmapFactory.decodeStream(it) } } catch (_: Exception) { null }
                        if (coverUrl == url) { cover = bmp; publish() }
                    }.start()
                }
            }
            "play" -> { playing = m.optBoolean("playing"); position = m.optLong("position") }
            "position" -> position = m.optLong("position")
            "stopped" -> playing = false
            else -> return
        }
        publish()
    }

    private fun publish() {
        session.setMetadata(
            MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist)
                .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, album)
                .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, duration)
                .putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, cover)
                .build()
        )
        session.setPlaybackState(
            PlaybackStateCompat.Builder()
                .setActions(
                    PlaybackStateCompat.ACTION_PLAY or PlaybackStateCompat.ACTION_PAUSE or PlaybackStateCompat.ACTION_PLAY_PAUSE or
                        PlaybackStateCompat.ACTION_SKIP_TO_NEXT or PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or PlaybackStateCompat.ACTION_SEEK_TO
                )
                .setState(if (playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED, position, if (playing) 1f else 0f, SystemClock.elapsedRealtime())
                .build()
        )
        goForeground()
    }

    private fun action(icon: Int, label: String, code: Long) =
        NotificationCompat.Action(icon, label, androidx.media.session.MediaButtonReceiver.buildMediaButtonPendingIntent(this, code))

    private fun goForeground() {
        val n: Notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_spotimfy)
            .setContentTitle(title.ifEmpty { "Spotimfy" })
            .setContentText(artist)
            .setLargeIcon(cover)
            .setContentIntent(openApp())
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(playing)
            .addAction(action(R.drawable.ic_prev, "Vorige", PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS))
            .addAction(
                if (playing) action(R.drawable.ic_pause, "Pauzeer", PlaybackStateCompat.ACTION_PAUSE)
                else action(R.drawable.ic_play, "Speel af", PlaybackStateCompat.ACTION_PLAY)
            )
            .addAction(action(R.drawable.ic_next, "Volgende", PlaybackStateCompat.ACTION_SKIP_TO_NEXT))
            .setStyle(MediaStyle().setMediaSession(session.sessionToken).setShowActionsInCompactView(0, 1, 2))
            .build()
        if (!foreground) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
            else startForeground(ID, n)
            foreground = true
        } else {
            getSystemService(NotificationManager::class.java).notify(ID, n)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        Core.unlisten(listener)
        session.release()
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL = "afspelen"
        private const val ID = 1
    }
}
