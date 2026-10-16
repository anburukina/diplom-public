import { useEffect, useState } from 'react';
import { getActuators, getSensors, meta } from '../api';
import { Topbar } from '../layout/Topbar';

// Отображение страницы датчиков и исполнительных устройств.
export function Sensors() {
  const [sensors, setSensors] = useState([]);
  const [actuators, setActuators] = useState([]);
  const [search, setSearch] = useState('');

  useEffect(() => {
    let mounted = true;
    Promise.all([
      getSensors({ search }),
      getActuators({ search }),
    ]).then(([sList, aList]) => {
      if (!mounted) return;
      setSensors(sList);
      setActuators(aList);
    });
    return () => {
      mounted = false;
    };
  }, [search]);

  const actuatorColumns = ['id', 'serial', 'name', 'type'];

  // Формирование заголовка колонки исполнительного устройства.
  const formatActuatorHeader = (key) => {
    const labels = {
      id: 'ID',
      name: 'Название',
      serial: 'Серийный номер',
      type: 'Тип устройства',
    };
    return labels[key] || key;
  };

  // Формирование значения ячейки исполнительного устройства.
  const formatActuatorValue = (item, key) => {
    if (key === 'serial') {
      const serial = item.serial ?? item.serial_number ?? item.actuators_serial_number ?? item.serialnumber ?? item.id ?? '—';
      return serial;
    }
    const val = item[key];
    if (val === null || val === undefined || val === '') return '—';
    if (typeof val === 'boolean') return val ? 'Вкл' : 'Выкл';
    return val;
  };

  // Формирование диапазона измерения датчика.
  const formatSensorRange = (sensor) => {
    const label = meta[sensor.parameter]?.label ?? sensor.parameter ?? '';
    if (label.toString().toLowerCase().includes('ndvi')) return '—';
    return `${sensor.min} — ${sensor.max} ${sensor.unit}`;
  };

  return (
    <div>
      <Topbar
        title="Оборудование"
        actions={
          <div className="list-inline">
            <span className="pill">Датчиков: {sensors.length}</span>
            <span className="pill">Исполнителей: {actuators.length}</span>
          </div>
        }
      />

      <div className="filters">
        <input
          className="input"
          placeholder="Поиск по ID или названию"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {/* фильтр по параметру убран по запросу */}
      </div>

      <div className="panel">
        <div className="card-row" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Датчики</h3>
          <div className="pill">Всего: {sensors.length}</div>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Серийный номер</th>
              <th>Название</th>
              <th>Параметр</th>
              <th>Диапазон</th>
            </tr>
          </thead>
          <tbody>
            {sensors.map((s) => (
              <tr key={s.id}>
                <td>{s.id}</td>
                <td>{s.serial ?? s.sensor_serial_number ?? '—'}</td>
                <td>{s.name}</td>
                <td className="muted">{meta[s.parameter]?.label ?? s.parameter}</td>
                <td className="muted">
                  {formatSensorRange(s)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="card-row" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Исполнительные устройства</h3>
          <div className="pill">Всего: {actuators.length}</div>
        </div>
        {actuators.length ? (
          <table className="table">
            <thead>
              <tr>
                {actuatorColumns.map((col) => (
                  <th key={col}>{formatActuatorHeader(col)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {actuators.map((a) => (
                <tr key={a.id ?? JSON.stringify(a)}>
                  {actuatorColumns.map((col) => (
                    <td key={col}>{formatActuatorValue(a, col)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="muted">Нет данных об исполнительных устройствах</div>
        )}
      </div>
    </div>
  );
}
