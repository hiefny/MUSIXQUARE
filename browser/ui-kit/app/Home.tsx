interface HomeProps {
  readonly onNext: () => void;
  readonly onPrev: () => void;
  readonly onTogglePlay: () => void;
  readonly playing: boolean;
  readonly track: UiKitNowPlayingTrack;
}

function Home({ playing, onTogglePlay, track, onNext, onPrev }: HomeProps): JSX.Element {
  return (
    <>
      <div className="mq-title">Home</div>

      <div className="mq-viz">
        <div className="ring" />
        <div className="ring" style={{ inset: '12%' }} />
        <div className="bars">
          {Array.from({ length: 18 }).map((_, index) => (
            <i
              key={index}
              style={{
                animationDelay: `${(index % 9) * 0.06}s`,
                animationPlayState: playing ? 'running' : 'paused',
                height: playing ? undefined : '12%',
              }}
            />
          ))}
        </div>
      </div>

      <div className="mq-track" style={{ marginTop: 18 }}>
        <h2 className="title">{track.title}</h2>
        <div className="artist">{track.artist}</div>
      </div>

      <div className="mq-seek">
        <div className="mq-seek-bar">
          <i style={{ width: `${track.progress}%` }} />
        </div>
        <div className="mq-seek-times">
          <span>{track.cur}</span>
          <span>{track.dur}</span>
        </div>
      </div>

      <div className="mq-transport">
        <button className="mq-iconbtn" aria-label="shuffle">
          <I.shuffle />
        </button>
        <button className="mq-iconbtn" aria-label="prev" onClick={onPrev}>
          <I.prev />
        </button>
        <button className="mq-fab" aria-label={playing ? 'pause' : 'play'} onClick={onTogglePlay}>
          {playing ? <I.pause /> : <I.play />}
        </button>
        <button className="mq-iconbtn" aria-label="next" onClick={onNext}>
          <I.next />
        </button>
        <button className="mq-iconbtn" aria-label="repeat" style={{ color: 'var(--primary)' }}>
          <I.repeat />
        </button>
      </div>
    </>
  );
}

window.Home = Home;
