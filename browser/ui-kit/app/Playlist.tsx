interface PlaylistProps {
  readonly activeIdx: number;
  readonly onAdd: () => void;
  readonly onPick: (index: number) => void;
  readonly onRemove: (index: number) => void;
  readonly playing: boolean;
  readonly tracks: readonly UiKitTrack[];
}

function PlaylistSourceIcon({ source }: { readonly source: UiKitTrackSource }): JSX.Element {
  if (source === 'youtube-playlist') {
    return (
      <svg className="mq-source-icon youtube" viewBox="0 0 24 24">
        <path d="M4 10h12v2H4zm0-4h12v2H4zm0 8h8v2H4zm10 0v6l5-3z" />
      </svg>
    );
  }

  return source === 'youtube' ? (
    <I.youtube className="mq-source-icon youtube" />
  ) : (
    <I.file className="mq-source-icon" />
  );
}

function Playlist({
  tracks,
  activeIdx,
  onPick,
  onRemove,
  onAdd,
  playing,
}: PlaylistProps): JSX.Element {
  return (
    <>
      <div
        className="mq-title"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <span>Playlist</span>
        <button className="mq-iconbtn" aria-label="add" onClick={onAdd}>
          <I.add />
        </button>
      </div>

      <div className="mq-list">
        {tracks.map((track, index) => {
          const active = index === activeIdx;
          return (
            <div key={index} className={'row' + (active ? ' active' : '')}>
              <button className="mq-track-leading" aria-label={`Reorder ${track.title}`}>
                <span className="idx">{index + 1}</span>
                {active &&
                  (playing ? (
                    <I.play className="mq-playback-state" />
                  ) : (
                    <I.pause className="mq-playback-state" />
                  ))}
                <I.grip className="mq-reorder-grip" />
              </button>
              <button
                className="mq-track-name"
                aria-label={`Play ${track.title}`}
                aria-pressed={active}
                onClick={() => onPick(index)}
              >
                <PlaylistSourceIcon source={track.source} />
                <span>{track.title}</span>
              </button>
              <button
                className="mq-track-remove"
                aria-label={`Remove ${track.title}`}
                onClick={() => onRemove(index)}
              >
                <I.close />
              </button>
            </div>
          );
        })}
      </div>

      {tracks.length === 0 && (
        <div
          style={{
            textAlign: 'center',
            color: 'var(--text-sub)',
            marginTop: 40,
            fontSize: 13,
          }}
        >
          No media yet.
        </div>
      )}
    </>
  );
}

window.Playlist = Playlist;
