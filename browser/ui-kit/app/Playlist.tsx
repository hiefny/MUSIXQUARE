interface PlaylistProps {
  readonly activeIdx: number;
  readonly onAdd: () => void;
  readonly onPick: (index: number) => void;
  readonly tracks: readonly UiKitTrack[];
}

function Playlist({ tracks, activeIdx, onPick, onAdd }: PlaylistProps): JSX.Element {
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

      <div className="mq-card">
        <div className="mq-list">
          {tracks.map((track, index) => (
            <div
              key={index}
              className={'row' + (index === activeIdx ? ' active' : '')}
              onClick={() => onPick(index)}
            >
              <span className="idx">{index + 1}</span>
              <span className="nm">{track.title}</span>
              <span className="dur">{track.dur}</span>
            </div>
          ))}
        </div>
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
