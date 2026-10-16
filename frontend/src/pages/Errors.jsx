import { useEffect, useMemo, useState } from 'react';
import { getErrors } from '../api';
import { Topbar } from '../layout/Topbar';
import StatusBadge from '../components/StatusBadge';
import { formatAlertText } from '../utils/alerts';
import { formatTs, statusLabel } from '../utils/format';

// Отображение журнала ошибок и событий
export function Errors() {
  const [errors, setErrors] = useState([]);
  const [query, setQuery] = useState('');

  useEffect(() => {
    // Загрузка журнала ошибок
    const load = async () => {
      try {
        const data = await getErrors();
        setErrors(data || []);
      } catch (e) {
        console.error('errors load error', e);
        setErrors([]);
      }
    };
    load();
  }, []);

  const filteredErrors = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return errors;
    return errors.filter((e) => {
      const code = (e.code ?? '').toString().toLowerCase();
      const text = formatAlertText(e).toString().toLowerCase();
      const severity = (e.severity ?? '').toString().toLowerCase();
      const label = statusLabel(e.severity).toString().toLowerCase();
      return code.includes(q) || text.includes(q) || severity.includes(q) || label.includes(q);
    });
  }, [errors, query]);

  return (
    <div>
      <Topbar
        title="Журнал ошибок и событий"
        actions={<div className="pill">Записей: {filteredErrors.length}</div>}
      />

      <div className="panel">
        <div className="filters">
          <label className="input-group">
            <div className="label">Поиск</div>
            <input
              className="input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Введите код или описание"
            />
          </label>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Время</th>
              <th>Код</th>
              <th>Статус</th>
              <th>Описание</th>
            </tr>
          </thead>
          <tbody>
            {filteredErrors.map((e) => (
              <tr key={e.id}>
                <td>{formatTs(e.ts)}</td>
                <td>{e.code}</td>
                <td>
                  <StatusBadge status={e.severity}>{statusLabel(e.severity)}</StatusBadge>
                </td>
                <td>{formatAlertText(e)}</td>
              </tr>
            ))}
            {!filteredErrors.length && (
              <tr>
                <td colSpan={4} className="muted">
                  Нет записей или загрузка не удалась
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
