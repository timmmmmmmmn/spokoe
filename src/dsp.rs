//! De geluidslaag tussen librespot en de uitgang: equalizer, balans, zachte start, crossfade en
//! snelheid (voor podcasts). In de bit-perfect-modus gaat alles er onaangeroerd doorheen.
//!
//! Crossfade: vlak voor het eind van een nummer houdt de laag de laatste seconden vast. Het
//! volgende nummer komt dan direct binnen (librespot decodeert sneller dan realtime) en wordt
//! met dat staartje gemengd: het ene zachter, het andere harder.

use std::collections::VecDeque;
use std::sync::Mutex;

use librespot::playback::audio_backend::{Sink, SinkResult};
use librespot::playback::convert::Converter;
use librespot::playback::decoder::AudioPacket;
use serde_json::Value;

const RATE: f64 = 44100.0;
pub const BANDS: [f64; 10] = [31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0];

#[derive(Clone)]
pub struct Params {
    pub bitperfect: bool,
    pub eq_on: bool,
    pub eq: [f64; 10],
    pub preamp: f64,
    pub balance: f64,
    /// Zachte start bij afspelen (ms); 0 = uit.
    pub fade_ms: f64,
    /// Crossfade tussen nummers (s); 0 = uit.
    pub crossfade: f64,
    /// Snelheid voor podcasts.
    pub speed: f64,
    version: u64,
}

impl Default for Params {
    fn default() -> Self {
        Self { bitperfect: false, eq_on: false, eq: [0.0; 10], preamp: 0.0, balance: 0.0, fade_ms: 40.0, crossfade: 0.0, speed: 1.0, version: 1 }
    }
}

/// Wat de afspeler over het huidige nummer weet (via de gebeurtenissen).
#[derive(Default)]
struct Track {
    /// Lengte in frames (één frame = links + rechts).
    frames: u64,
    /// Een nieuw nummer is begonnen.
    changed: bool,
    /// Er is gespoeld: de positie klopt niet meer met wat we tellen.
    jumped: Option<u64>,
    episode: bool,
}

static PARAMS: Mutex<Option<Params>> = Mutex::new(None);
static TRACK: Mutex<Option<Track>> = Mutex::new(None);
/// Pauze met een korte fade: de doelversterking (1 = normaal).
static TARGET: Mutex<f64> = Mutex::new(1.0);

pub fn params() -> Params {
    PARAMS.lock().unwrap().get_or_insert_with(Params::default).clone()
}

/// Instellingen uit de pagina (alleen de velden die erin staan).
pub fn set(v: &Value) {
    let mut guard = PARAMS.lock().unwrap();
    let p = guard.get_or_insert_with(Params::default);
    if let Some(b) = v["bitperfect"].as_bool() {
        p.bitperfect = b;
    }
    if let Some(b) = v["eqOn"].as_bool() {
        p.eq_on = b;
    }
    if let Some(a) = v["eq"].as_array() {
        for (i, g) in a.iter().take(10).enumerate() {
            p.eq[i] = g.as_f64().unwrap_or(0.0).clamp(-12.0, 12.0);
        }
    }
    if let Some(x) = v["preamp"].as_f64() {
        p.preamp = x.clamp(-12.0, 6.0);
    }
    if let Some(x) = v["balance"].as_f64() {
        p.balance = x.clamp(-1.0, 1.0);
    }
    if let Some(x) = v["fadeMs"].as_f64() {
        p.fade_ms = x.clamp(0.0, 1000.0);
    }
    if let Some(x) = v["crossfade"].as_f64() {
        p.crossfade = x.clamp(0.0, 12.0);
    }
    if let Some(x) = v["speed"].as_f64() {
        p.speed = x.clamp(0.5, 3.0);
    }
    p.version += 1;
}

fn track<R>(f: impl FnOnce(&mut Track) -> R) -> R {
    f(TRACK.lock().unwrap().get_or_insert_with(Track::default))
}

pub fn track_changed(duration_ms: u32, episode: bool) {
    track(|t| {
        t.frames = (duration_ms as f64 * RATE / 1000.0) as u64;
        t.changed = true;
        t.jumped = None;
        t.episode = episode;
    });
}

pub fn seeked(position_ms: u32) {
    track(|t| t.jumped = Some((position_ms as f64 * RATE / 1000.0) as u64));
}

/// Kort uitfaden (voor pauzeren); `start()` zet het daarna weer op normaal.
pub fn fade_out() {
    *TARGET.lock().unwrap() = 0.0;
}

#[derive(Clone, Copy, Default)]
struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    x1: f64,
    x2: f64,
    y1: f64,
    y2: f64,
}

impl Biquad {
    /// Piekfilter (RBJ-kookboek).
    fn peaking(freq: f64, gain_db: f64, q: f64) -> Self {
        let a = 10f64.powf(gain_db / 40.0);
        let w = 2.0 * std::f64::consts::PI * freq / RATE;
        let alpha = w.sin() / (2.0 * q);
        let a0 = 1.0 + alpha / a;
        Self {
            b0: (1.0 + alpha * a) / a0,
            b1: -2.0 * w.cos() / a0,
            b2: (1.0 - alpha * a) / a0,
            a1: -2.0 * w.cos() / a0,
            a2: (1.0 - alpha / a) / a0,
            ..Default::default()
        }
    }

    fn retune(&mut self, other: &Biquad) {
        self.b0 = other.b0;
        self.b1 = other.b1;
        self.b2 = other.b2;
        self.a1 = other.a1;
        self.a2 = other.a2;
    }

    #[inline]
    fn run(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2 - self.a1 * self.y1 - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }
}

/// Tijdrekken zonder toonhoogte te veranderen (WSOLA), voor podcasts.
struct Stretch {
    input: Vec<f64>,
    prev_tail: Vec<f64>,
    pos: f64,
}

const WIN: usize = 1024;
const HOP: usize = WIN / 2;
const SEEK: usize = 256;

impl Stretch {
    fn new() -> Self {
        Self { input: Vec::new(), prev_tail: Vec::new(), pos: 0.0 }
    }

    fn reset(&mut self) {
        self.input.clear();
        self.prev_tail.clear();
        self.pos = 0.0;
    }

    /// Stereo erin (interleaved), stereo eruit.
    fn process(&mut self, samples: &[f64], speed: f64, out: &mut Vec<f64>) {
        self.input.extend_from_slice(samples);
        let frames = |v: &Vec<f64>| v.len() / 2;
        let window: Vec<f64> = (0..WIN).map(|i| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / WIN as f64).cos()).collect();
        loop {
            let start = self.pos as usize;
            if start + WIN + SEEK * 2 >= frames(&self.input) {
                break;
            }
            // Zoek rond de verwachte plek naar het stukje dat het best aansluit op het vorige.
            let mut best = start;
            if !self.prev_tail.is_empty() {
                let mut best_score = f64::MIN;
                let lo = start.saturating_sub(SEEK);
                for cand in (lo..start + SEEK).step_by(8) {
                    let mut score = 0.0;
                    for i in (0..HOP).step_by(4) {
                        let a = self.prev_tail[i * 2] + self.prev_tail[i * 2 + 1];
                        let b = self.input[(cand + i) * 2] + self.input[(cand + i) * 2 + 1];
                        score += a * b;
                    }
                    if score > best_score {
                        best_score = score;
                        best = cand;
                    }
                }
            }
            // Overlap-add: de eerste helft van dit venster met de staart van het vorige.
            for i in 0..HOP {
                for ch in 0..2 {
                    let cur = self.input[(best + i) * 2 + ch] * window[i];
                    let prev = self.prev_tail.get(i * 2 + ch).copied().unwrap_or(0.0);
                    out.push(cur + prev);
                }
            }
            self.prev_tail = (HOP..WIN).flat_map(|i| (0..2).map(move |ch| (i, ch))).map(|(i, ch)| self.input[(best + i) * 2 + ch] * window[i]).collect();
            self.pos += HOP as f64 * speed;
        }
        // Wat al verwerkt is weggooien (met marge om terug te zoeken).
        let keep_from = (self.pos as usize).saturating_sub(SEEK);
        if keep_from > 0 {
            self.input.drain(..keep_from * 2);
            self.pos -= keep_from as f64;
        }
    }
}

/// Maakt de echte uitgang (opnieuw) aan.
pub type Opener = Box<dyn Fn() -> Box<dyn Sink> + Send>;

pub struct DspSink {
    /// Alleen open zolang er gespeeld wordt: op pauze geven we het audioapparaat vrij
    /// (anders houdt het systeem de app voor "actief" en kan de computer niet slapen).
    inner: Option<Box<dyn Sink>>,
    open: Opener,
    version: u64,
    p: Params,
    eq: [[Biquad; 10]; 2],
    /// Versterking voor de zachte start en de fade bij pauzeren.
    gain: f64,
    /// Positie in het huidige nummer (frames die we kregen).
    pos: u64,
    /// Vastgehouden staart van het vorige nummer (crossfade).
    tail: VecDeque<f64>,
    holding: bool,
    /// Bezig met mengen: hoe lang de staart was, en hoeveel er al gemengd is.
    mixing: Option<(usize, usize)>,
    stretch: Stretch,
}

impl DspSink {
    pub fn new(open: Opener) -> Self {
        Self {
            inner: None,
            open,
            version: 0,
            p: Params::default(),
            eq: [[Biquad::default(); 10]; 2],
            gain: 1.0,
            pos: 0,
            tail: VecDeque::new(),
            holding: false,
            mixing: None,
            stretch: Stretch::new(),
        }
    }

    fn refresh(&mut self) {
        let p = params();
        if p.version == self.version {
            return;
        }
        for (i, &f) in BANDS.iter().enumerate() {
            let tuned = Biquad::peaking(f, p.eq[i], 1.1);
            for ch in 0..2 {
                self.eq[ch][i].retune(&tuned);
            }
        }
        self.version = p.version;
        self.p = p;
    }

    /// EQ, balans en de zachte start op een stuk geluid.
    fn shape(&mut self, s: &mut [f64]) {
        let p = &self.p;
        let pre = 10f64.powf(p.preamp / 20.0);
        let (gl, gr) = ((1.0 - p.balance).min(1.0), (1.0 + p.balance).min(1.0));
        let target = *TARGET.lock().unwrap();
        // Van 0 naar 1 in fade_ms, of snel (120 ms) naar 0 bij pauzeren.
        let step = if target < self.gain { 1.0 / (0.12 * RATE) } else if p.fade_ms > 0.0 { 1.0 / (p.fade_ms / 1000.0 * RATE) } else { 1.0 };
        let eq = p.eq_on && p.eq.iter().any(|g| g.abs() > 0.01);
        for frame in s.chunks_exact_mut(2) {
            if self.gain != target {
                self.gain = if target > self.gain { (self.gain + step).min(target) } else { (self.gain - step).max(target) };
            }
            // Zachte (kwadratische) curve: klinkt natuurlijker dan rechtlijnig.
            let g = self.gain * self.gain;
            for ch in 0..2 {
                let mut x = frame[ch];
                if eq {
                    x *= pre;
                    for b in self.eq[ch].iter_mut() {
                        x = b.run(x);
                    }
                }
                frame[ch] = x * g * if ch == 0 { gl } else { gr };
            }
        }
    }

    fn inner(&mut self) -> &mut Box<dyn Sink> {
        if self.inner.is_none() {
            let mut sink = (self.open)();
            let _ = sink.start();
            self.inner = Some(sink);
        }
        self.inner.as_mut().unwrap()
    }

    fn out(&mut self, samples: Vec<f64>, conv: &mut Converter) -> SinkResult<()> {
        if samples.is_empty() {
            return Ok(());
        }
        self.inner().write(AudioPacket::Samples(samples), conv)
    }
}

impl Sink for DspSink {
    fn start(&mut self) -> SinkResult<()> {
        self.refresh();
        *TARGET.lock().unwrap() = 1.0;
        self.gain = if self.p.bitperfect || self.p.fade_ms <= 0.0 { 1.0 } else { 0.0 };
        // Het apparaat gaat pas open bij het eerste geluid (zie inner()).
        Ok(())
    }

    fn stop(&mut self) -> SinkResult<()> {
        self.stretch.reset();
        let near_end = track(|t| t.frames > 0 && self.pos + (RATE as u64) >= t.frames);
        if self.holding && near_end && !self.tail.is_empty() {
            // Einde van de lijst: het vastgehouden staartje nog laten horen, wegfadend.
            let n = self.tail.len() / 2;
            let mut rest: Vec<f64> = self.tail.drain(..).collect();
            for (i, frame) in rest.chunks_exact_mut(2).enumerate() {
                let g = 1.0 - i as f64 / n as f64;
                frame[0] *= g;
                frame[1] *= g;
            }
            let mut conv = Converter::new(None);
            let _ = self.out(rest, &mut conv);
        }
        self.tail.clear();
        self.holding = false;
        self.mixing = None;
        // Laten uitspelen wat er nog in de buffer zit, en dan het apparaat vrijgeven.
        let result = self.inner.as_mut().map(|s| s.stop()).unwrap_or(Ok(()));
        self.inner = None;
        result
    }

    fn write(&mut self, packet: AudioPacket, conv: &mut Converter) -> SinkResult<()> {
        self.refresh();
        let AudioPacket::Samples(mut s) = packet else { return self.inner().write(packet, conv) };
        if self.p.bitperfect {
            return self.inner().write(AudioPacket::Samples(s), conv);
        }
        let (changed, jumped, frames, episode) = track(|t| {
            let r = (t.changed, t.jumped.take(), t.frames, t.episode);
            t.changed = false;
            r
        });
        if let Some(at) = jumped {
            // Gespoeld: niets vasthouden van voor de sprong.
            self.pos = at;
            self.tail.clear();
            self.holding = false;
            self.mixing = None;
            self.stretch.reset();
        }
        if changed {
            self.pos = 0;
            self.stretch.reset();
            if self.holding && !self.tail.is_empty() {
                self.holding = false;
                self.mixing = Some((self.tail.len() / 2, 0));
            }
        }
        self.pos += (s.len() / 2) as u64;

        self.shape(&mut s);

        // Crossfade: de laatste seconden van een nummer vasthouden tot het volgende er is.
        let xf = (self.p.crossfade * RATE) as u64;
        if xf > 0 && self.mixing.is_none() && frames > xf * 3 && self.pos + xf >= frames {
            self.holding = true;
        }
        if self.holding {
            self.tail.extend(s);
            return Ok(());
        }
        if let Some((len, done)) = self.mixing {
            let n = (s.len() / 2).min(len - done);
            for i in 0..n {
                let k = (done + i) as f64 / len as f64;
                // Gelijke-energie-curve: geen dip in het midden.
                let (fade_out, fade_in) = ((k * std::f64::consts::FRAC_PI_2).cos(), (k * std::f64::consts::FRAC_PI_2).sin());
                for ch in 0..2 {
                    let a = self.tail.pop_front().unwrap_or(0.0);
                    s[i * 2 + ch] = a * fade_out + s[i * 2 + ch] * fade_in;
                }
            }
            self.mixing = if done + n >= len { None } else { Some((len, done + n)) };
            if self.mixing.is_none() {
                self.tail.clear();
            }
        }

        // Podcasts sneller of langzamer, zonder dat de stem verandert.
        if episode && (self.p.speed - 1.0).abs() > 0.01 {
            let mut stretched = Vec::with_capacity((s.len() as f64 / self.p.speed) as usize + 4096);
            self.stretch.process(&s, self.p.speed, &mut stretched);
            return self.out(stretched, conv);
        }
        self.out(s, conv)
    }
}
