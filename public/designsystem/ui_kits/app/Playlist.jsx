// Playlist tab
function Playlist({ tracks, activeIdx, onPick, onAdd }) {
  return (
    <>
      <div className="mq-title" style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <span>Playlist</span>
        <button className="mq-iconbtn" aria-label="add" onClick={onAdd}><I.add/></button>
      </div>

      <div className="mq-card">
        <div className="mq-list">
          {tracks.map((t, i) => (
            <div key={i}
                 className={'row' + (i === activeIdx ? ' active' : '')}
                 onClick={() => onPick(i)}>
              <span className="idx">{i + 1}</span>
              <span className="nm">{t.title}</span>
              <span className="dur">{t.dur}</span>
            </div>
          ))}
        </div>
      </div>

      {tracks.length === 0 && (
        <div style={{ textAlign: 'center', color: 'var(--text-sub)', marginTop: 40, fontSize: 13 }}>
          Please add media.
        </div>
      )}
    </>
  );
}
window.Playlist = Playlist;
