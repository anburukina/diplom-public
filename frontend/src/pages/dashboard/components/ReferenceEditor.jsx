/** Отображение формы изменения референсных диапазонов параметров. */
export function ReferenceEditor({
  editError,
  editMax,
  editMin,
  editParam,
  editSuccess,
  employee,
  loadedRef,
  onCancel,
  onEditMaxChange,
  onEditMinChange,
  onEditParamChange,
  onSubmit,
  parameters,
  saving,
}) {
  return (
    <div id="reference-editor" className="panel dashboard-panel">
      <div className="card-row dashboard-panel-heading">
        <h3 className="reference-editor-title">Изменение параметров</h3>
      </div>
      <div className="grid cols-2 reference-editor-grid">
        <div>
          <div className="card-row reference-param-row">
            <div className="subtitle">Параметр</div>
            <select className="input" value={editParam} onChange={(e) => onEditParamChange(e.target.value)}>
              {parameters.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name || p.id}
                </option>
              ))}
            </select>
          </div>
          <div className="form-grid">
            <label className="input-group">
              <div className="label">Минимум</div>
              <input
                className="input"
                type="number"
                value={editMin}
                placeholder={loadedRef.min !== '' ? loadedRef.min : undefined}
                onChange={(e) => onEditMinChange(e.target.value)}
              />
            </label>
            <label className="input-group">
              <div className="label">Максимум</div>
              <input
                className="input"
                type="number"
                value={editMax}
                placeholder={loadedRef.max !== '' ? loadedRef.max : undefined}
                onChange={(e) => onEditMaxChange(e.target.value)}
              />
            </label>
          </div>
          {employee && (
            <div className="muted reference-user">
              Активный пользователь: {employee.name}
            </div>
          )}
          {editError && <div className="pill danger reference-message">{editError}</div>}
          {editSuccess && <div className="pill success reference-message">{editSuccess}</div>}
          <div className="list-inline reference-actions">
            <button className="btn primary" disabled={saving || !editParam || !employee?.id} onClick={onSubmit}>
              Подтвердить изменение
            </button>
            <button className="btn ghost" disabled={saving} onClick={onCancel}>
              Отмена / Сброс
            </button>
          </div>
        </div>
        <div />
      </div>
    </div>
  );
}
