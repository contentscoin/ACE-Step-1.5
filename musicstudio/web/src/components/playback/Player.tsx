/**
 * The player: waveform, playhead, seek, loop, and the lyric line showing now.
 *
 * Requirements 12.1, 12.3, 12.5, 12.7, 12.9.
 *
 * ### The playhead is a clock reading, not a counter
 *
 * `positionAfter` is asked where the elapsed time lands, and for a loop asset that is
 * `positionAt` — the domain function — rather than a modulo written here. It matters at exactly one
 * instant: at `durationMs` the playhead is at the *start of the next pass*, not the end of this
 * one, and a UI counting frames of its own would either repeat that millisecond or skip it.
 *
 * ### Seeking is a click on the drawing
 *
 * Requirement 12.3 gives a seek one second to start playing, and the way a user asks for one is by
 * clicking the waveform. The bucket clicked maps back to a time through `bucketStartMs`, the same
 * arithmetic that produced the drawing — so the position the user pointed at is the position they
 * get, rather than one off by the remainder the buckets absorbed.
 *
 * ### The transport drives an `<audio>` element, not only a clock
 *
 * It used to drive only the clock: pressing 재생 started a 100 ms `setInterval`, the playhead
 * advanced, the lyric line changed, and **nothing made a sound**. Every reading on screen was
 * derived from wall time, so the screen was indistinguishable from one playing audio — which is
 * the failure, not the silence. `streamUrl` was never read.
 *
 * So there is a real element now, and the clock follows *it* rather than the wall: `timeupdate`
 * carries the element's own `currentTime`. A second clock running beside a media element drifts
 * from it — the element stalls to buffer, the interval does not — and the drift shows up as a
 * lyric line that no longer matches what is playing. Where the element cannot load (a test DOM
 * with no media stack, `streamUrl` returning nothing), the interval still runs, because a
 * transport that renders nothing is harder to reason about than one that runs dry.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { bucketStartMs, type Waveform } from '@domain/playback/waveform';
import type { ActiveLyricLine } from '@domain/playback/lyrics-sync';

import { useStudioApi } from '../../lib/api/context';
import type { StudioAsset } from '../../lib/api/types';
import { button, formatTime, meta, panel, row, tabular } from '../../styles/ui';

/** How often the playhead advances while playing. 100 ms reads as smooth and costs nothing. */
const TICK_MS = 100;

/** Buckets requested for the drawing. Fewer than the default: this is a 720 px panel. */
const DISPLAY_BUCKETS = 240;

export interface PlayerProps {
  readonly asset: StudioAsset;
}

export function Player({ asset }: PlayerProps): ReactNode {
  const api = useStudioApi();

  const [waveform, setWaveform] = useState<Waveform | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [line, setLine] = useState<ActiveLyricLine | null>(null);
  const [pass, setPass] = useState(0);
  const [positionMs, setPositionMs] = useState(0);
  const barsRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** True once the element has told us it has media. Until then the interval is the only clock. */
  const [audioReady, setAudioReady] = useState(false);

  const streamUrl = api.streamUrl(asset.id);

  useEffect(() => {
    void api.waveform(asset.id, DISPLAY_BUCKETS).then(setWaveform);
  }, [api, asset.id]);

  // Play state to the element. `play()` rejects when the browser has no gesture to attach the
  // sound to; that is a refusal to make noise, not an error to surface, so the transport simply
  // returns to paused and the user's next click is the gesture.
  useEffect(() => {
    const element = audioRef.current;
    if (element === null) return;
    if (playing) {
      const started = element.play();
      if (started !== undefined) {
        void started.catch(() => {
          setPlaying(false);
        });
      }
    } else {
      element.pause();
    }
  }, [playing]);

  // The playhead. With media loaded the element is the clock (see the header); without it the
  // interval stands in so the transport still moves.
  useEffect(() => {
    if (!playing || audioReady) return;
    const timer = setInterval(() => {
      setElapsedMs((current) => current + TICK_MS);
    }, TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [playing, audioReady]);

  useEffect(() => {
    void api.positionAfter(asset.id, elapsedMs).then((position) => {
      setPositionMs(position.positionMs);
      setPass(position.pass);
      // Requirement 12.5: the line for *that* position, not for the elapsed time.
      void api.lyricLineAt(asset.id, position.positionMs).then(setLine);
    });

    // A non-looping asset stops at its end rather than running the clock past it.
    if (!asset.isLoop && elapsedMs >= asset.durationMs) setPlaying(false);
  }, [api, asset.id, asset.isLoop, asset.durationMs, elapsedMs]);

  const seekToBucket = useCallback(
    (index: number, buckets: number) => {
      const target = bucketStartMs(index, buckets, asset.durationMs);
      // Seeking inside a loop keeps the pass the user is on, so the display does not jump back.
      setElapsedMs(pass * asset.durationMs + target);
      // The element carries one pass of the asset, so it seeks to the position *within* the pass.
      const element = audioRef.current;
      if (element !== null) element.currentTime = target / 1000;
    },
    [asset.durationMs, pass],
  );

  const restart = useCallback(() => {
    setElapsedMs(0);
    const element = audioRef.current;
    if (element !== null) element.currentTime = 0;
  }, []);

  const progress = asset.durationMs === 0 ? 0 : positionMs / asset.durationMs;

  return (
    <div style={panel}>
      {streamUrl !== '' && (
        <audio
          ref={audioRef}
          src={streamUrl}
          // A looping asset loops the element too, so the seam the domain describes is the seam
          // that is heard. `pass` still comes from `positionAfter`, which counts them.
          loop={asset.isLoop}
          preload="metadata"
          onCanPlay={() => {
            setAudioReady(true);
          }}
          onTimeUpdate={(event) => {
            // The element's own clock, promoted to the transport's. Adding the completed passes
            // back in keeps a loop's total elapsed time monotonic across the seam.
            setElapsedMs(pass * asset.durationMs + event.currentTarget.currentTime * 1000);
          }}
          onEnded={() => {
            setPlaying(false);
          }}
          onError={() => {
            // Nothing to play from. Hand the clock back to the interval rather than freezing the
            // transport, and let the user see it run.
            setAudioReady(false);
          }}
        >
          <track kind="captions" />
        </audio>
      )}

      <div
        ref={barsRef}
        role="group"
        aria-label="파형"
        style={{ display: 'flex', alignItems: 'center', gap: 1, height: 72, cursor: 'pointer' }}
        onClick={(event) => {
          const box = barsRef.current?.getBoundingClientRect();
          if (box === undefined || waveform === null) return;
          const ratio = (event.clientX - box.left) / box.width;
          seekToBucket(Math.round(ratio * waveform.buckets.length), waveform.buckets.length);
        }}
      >
        {waveform?.buckets.map((bucket, index) => {
          const played = index / waveform.buckets.length <= progress;
          return (
            <span
              key={index}
              style={{
                display: 'block',
                flex: 1,
                height: `${String(Math.max(4, bucket.max * 100))}%`,
                background: played ? 'var(--accent)' : 'var(--line)',
                borderRadius: 1,
              }}
            />
          );
        })}
      </div>

      <div style={{ ...row, marginTop: 12 }}>
        <button
          type="button"
          style={button}
          onClick={() => {
            setPlaying((current) => !current);
          }}
        >
          {playing ? '일시정지' : '재생'}
        </button>
        <button type="button" style={button} onClick={restart}>
          처음으로
        </button>
        <span style={{ ...tabular, ...meta }}>
          {formatTime(positionMs)} / {formatTime(asset.durationMs)}
          {asset.isLoop && <> · {pass + 1}회차</>}
        </span>
        {asset.isLoop && <span style={meta}>루프 자산 (Req 12.9)</span>}
      </div>

      {api.backend.kind === 'demo' && (
        <p style={{ ...meta, marginTop: 8 }}>
          들리는 소리는 생성된 음악이 아니라 데모 백엔드가 자산 식별자로 합성한 톤입니다.
        </p>
      )}

      {asset.timedLyrics !== null && (
        <p style={{ marginTop: 12, minHeight: 24, fontSize: 18 }} aria-live="polite">
          {line?.text ?? <span style={meta}>— 인트로 —</span>}
        </p>
      )}
    </div>
  );
}
