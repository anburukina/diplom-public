import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { forceWateringBatch, getZones } from '../api';
import { useAuth } from '../auth';
import { Topbar } from '../layout/Topbar';
import { useAutoRefresh } from '../hooks/useAutoRefresh';
import { formatNumber } from '../utils/format';
import {
  compareZonesByGrid,
  getWateringDurationSec,
  getZoneColumn,
  getZoneDisplayName,
  isAeroZone,
  isHydroZone,
} from '../utils/zones';

const STATUS_TIMEOUT_MS = 4000;

// Получение названия технологии зоны
const getTechnologyName = (zone) => zone?.technologyName || zone?.technology || '';

// Получение текстового статуса полива зоны
const getWateringStatus = (zone) => {
  const isRunning = zone?.isWatering ?? zone?.status === 'watering';
  return isRunning ? 'идет' : 'не идет';
};

// Отображение группы зон одной технологии
function ZoneGroup({ title, zones, maxColumns }) {
  if (!zones.length) return null;

  return (
    <div style={{ marginTop: 12 }}>
      <h3 style={{ margin: '12px 0 8px' }}>{title}</h3>
      <div className="grid zone-grid" style={{ '--zone-cols': maxColumns > 0 ? maxColumns : 1 }}>
        {zones.map((zone) => {
          const isRunning = zone?.isWatering ?? zone?.status === 'watering';
          const statusClass = isRunning ? 'watering' : 'idle';
          const ndviValue = zone?.ndvi ?? zone?.ndvi_value ?? zone?.ndviValue;

          return (
            <div key={zone.id} className="panel zone-card">
              <div className="card-row" style={{ marginBottom: 10 }}>
                <div>
                  <h3 style={{ margin: 0 }}>{getZoneDisplayName(zone)}</h3>
                  <div className="subtitle">{getTechnologyName(zone) || '—'}</div>
                </div>
              </div>

              <div className="row-grid zone-metrics" style={{ marginBottom: 10 }}>
                <div className="row-tile metric">
                  <div className="row-title">NDVI</div>
                  <div className="row-meta">{formatNumber(ndviValue, 2)}</div>
                </div>
              </div>

              <div className={`row-tile zone-watering ${statusClass}`} title={`Полив: ${getWateringStatus(zone)}`}>
                <div className="row-title">Полив: {getWateringStatus(zone)}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Отображение страницы зон полива
export function Zones() {
  const { employee } = useAuth();
  const [searchParams] = useSearchParams();
  const [zones, setZones] = useState([]);
  const [search, setSearch] = useState('');
  const [tech, setTech] = useState('');
  const [forceTech, setForceTech] = useState('');
  const [forceZoneIds, setForceZoneIds] = useState([]);
  const [forceDropdownOpen, setForceDropdownOpen] = useState(false);
  const [forceStatus, setForceStatus] = useState({ type: '', text: '' });
  const [forceLoading, setForceLoading] = useState(false);
  const statusTimerRef = useRef(null);
  const forceDropdownRef = useRef(null);
  const appliedForceZoneRef = useRef(false);

  // Загрузка списка зон
  const load = useCallback(async () => {
    const data = await getZones();
    setZones(Array.isArray(data) ? data : []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useAutoRefresh(load, 4000);

  useEffect(() => {
    if (appliedForceZoneRef.current || !zones.length) return;

    const forceZoneId = searchParams.get('forceZoneId');
    if (!forceZoneId) return;

    const zone = zones.find((item) => String(item.id) === String(forceZoneId));
    if (!zone) return;

    appliedForceZoneRef.current = true;
    setForceZoneIds([String(zone.id)]);
    setForceTech(getTechnologyName(zone));
    setForceStatus({
      type: 'warning',
      text: `Требуется запуск принудительного полива. ${getTechnologyName(zone)}. ${getZoneDisplayName(zone)}.`,
    });

    if (window.location.hash === '#watering-control') {
      requestAnimationFrame(() => {
        document.getElementById('watering-control')?.scrollIntoView({ block: 'center' });
      });
    }
  }, [searchParams, zones]);

  useEffect(() => {
    if (!forceStatus.text || forceStatus.type === 'danger') return undefined;
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(() => {
      setForceStatus({ type: '', text: '' });
      statusTimerRef.current = null;
    }, STATUS_TIMEOUT_MS);

    return () => {
      if (statusTimerRef.current) {
        clearTimeout(statusTimerRef.current);
        statusTimerRef.current = null;
      }
    };
  }, [forceStatus]);

  useEffect(() => {
    if (!forceDropdownOpen) return undefined;
    // Закрытие выпадающего списка при клике вне блока
    const handleClick = (event) => {
      if (forceDropdownRef.current && !forceDropdownRef.current.contains(event.target)) {
        setForceDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [forceDropdownOpen]);

  const filteredZones = useMemo(() => {
    const searchValue = search.trim().toLowerCase();
    return zones.filter((zone) => {
      if (tech && getTechnologyName(zone) !== tech) return false;
      if (!searchValue) return true;
      return String(zone.name || '').toLowerCase().includes(searchValue);
    });
  }, [zones, search, tech]);

  const technologies = useMemo(
    () => Array.from(new Set(zones.map(getTechnologyName).filter(Boolean))).sort(),
    [zones],
  );

  const forceZones = useMemo(() => {
    if (!forceTech) return zones;
    return zones.filter((zone) => getTechnologyName(zone) === forceTech);
  }, [zones, forceTech]);

  useEffect(() => {
    const allowed = new Set(forceZones.map((zone) => String(zone.id)));
    setForceZoneIds((prev) => prev.filter((id) => allowed.has(String(id))));
  }, [forceZones]);

  const maxColumns = useMemo(() => {
    const cols = filteredZones.map(getZoneColumn).filter((value) => value != null);
    return cols.length ? Math.max(...cols) : 0;
  }, [filteredZones]);

  const grouped = useMemo(() => {
    const result = { hydro: [], aero: [], other: [] };
    filteredZones.forEach((zone) => {
      if (isHydroZone(zone)) result.hydro.push(zone);
      else if (isAeroZone(zone)) result.aero.push(zone);
      else result.other.push(zone);
    });

    result.hydro.sort(compareZonesByGrid);
    result.aero.sort(compareZonesByGrid);
    result.other.sort(compareZonesByGrid);
    return result;
  }, [filteredZones]);

  const selectedZones = useMemo(() => {
    if (!forceZoneIds.length) return [];
    const byId = new Map(zones.map((zone) => [String(zone.id), zone]));
    return forceZoneIds.map((id) => byId.get(String(id))).filter(Boolean);
  }, [zones, forceZoneIds]);

  const selectedZonesLabel = useMemo(() => {
    if (!selectedZones.length) return 'Выберите зону';
    if (selectedZones.length === 1) return getZoneDisplayName(selectedZones[0]);
    if (selectedZones.length <= 3) return selectedZones.map(getZoneDisplayName).join(', ');
    return `Выбрано: ${selectedZones.length}`;
  }, [selectedZones]);

  const durationLabel = useMemo(() => {
    if (!selectedZones.length) return null;
    const hasHydro = selectedZones.some(isHydroZone);
    const hasAero = selectedZones.some(isAeroZone);
    const hasOther = selectedZones.some((zone) => !isHydroZone(zone) && !isAeroZone(zone));
    const parts = [];
    if (hasHydro) parts.push('гидропоника 10 минут');
    if (hasAero) parts.push('аэропоника 10 секунд');
    if (hasOther) parts.push('другая технология');
    return parts.join(', ');
  }, [selectedZones]);

  // Переключение выбранной зоны для принудительного полива
  const toggleForceZone = useCallback((id) => {
    const key = String(id);
    setForceZoneIds((prev) => (prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]));
  }, []);

  // Запуск принудительного полива выбранных зон
  const handleForce = async () => {
    if (!forceZoneIds.length || !selectedZones.length) {
      setForceStatus({ type: 'danger', text: 'Выберите зоны' });
      return;
    }

    const invalidZones = selectedZones.filter((zone) => getWateringDurationSec(zone) == null);
    if (invalidZones.length) {
      const names = invalidZones.map(getZoneDisplayName).join(', ');
      setForceStatus({ type: 'danger', text: `Неизвестная технология: ${names}` });
      return;
    }

    setForceLoading(true);
    setForceStatus({ type: '', text: '' });
    try {
      const res = await forceWateringBatch(
        selectedZones.map((zone) => zone.id),
        { startedByEmployee: employee?.id ?? null },
      );
      const results = Array.isArray(res?.results) ? res.results : [];
      const failed = results.filter((result) => !result.ok);
      const success = results.filter((result) => result.ok);

      if (success.length && !failed.length) {
        setForceStatus({ type: 'success', text: `Полив запущен: ${selectedZones.map(getZoneDisplayName).join(', ')}` });
      } else if (success.length && failed.length) {
        const failedIds = new Set(failed.map((result) => String(result.id)));
        const failedNames = selectedZones
          .filter((zone) => failedIds.has(String(zone.id)))
          .map(getZoneDisplayName)
          .join(', ');
        setForceStatus({
          type: 'warning',
          text: `Запущено: ${success.length}. Не удалось: ${failedNames || failed.length}`,
        });
      } else {
        setForceStatus({ type: 'danger', text: 'Не удалось запустить полив' });
      }
    } catch (e) {
      console.error(e);
      setForceStatus({ type: 'danger', text: 'Не удалось запустить полив' });
    } finally {
      setForceLoading(false);
      try {
        await load();
      } catch (loadError) {
        console.error('zones reload error', loadError);
      }
    }
  };

  return (
    <div>
      <Topbar title="Зоны полива" actions={<div className="pill">Всего зон: {filteredZones.length}</div>} />

      <div className="filters">
        <input
          className="input"
          placeholder="Поиск по названию"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select className="input" value={tech} onChange={(event) => setTech(event.target.value)}>
          <option value="">Все технологии</option>
          {technologies.map((technology) => (
            <option key={technology} value={technology}>
              {technology}
            </option>
          ))}
        </select>
      </div>

      <div id="watering-control" className="filters" style={{ marginTop: 10 }}>
        <select
          className="input"
          value={forceTech}
          onChange={(event) => setForceTech(event.target.value)}
          title="Технология для принудительного полива"
        >
          <option value="">Все технологии</option>
          {technologies.map((technology) => (
            <option key={technology} value={technology}>
              {technology}
            </option>
          ))}
        </select>

        <div className="multi-select" ref={forceDropdownRef}>
          <button
            className={`input multi-select-trigger${forceDropdownOpen ? ' open' : ''}`}
            type="button"
            onClick={() => setForceDropdownOpen((prev) => !prev)}
            title="Выберите зоны для принудительного полива"
          >
            <span className={!selectedZones.length ? 'placeholder' : undefined}>{selectedZonesLabel}</span>
            <span className="multi-select-caret">▾</span>
          </button>

          {forceDropdownOpen && (
            <div className="multi-select-menu">
              {forceZones.map((zone) => {
                const id = String(zone.id);
                return (
                  <label key={id} className="multi-select-option">
                    <input type="checkbox" checked={forceZoneIds.includes(id)} onChange={() => toggleForceZone(id)} />
                    <span>{getZoneDisplayName(zone)}</span>
                  </label>
                );
              })}
              {!forceZones.length && <div className="multi-select-empty">Нет зон</div>}
            </div>
          )}
        </div>

        <button className="btn primary" type="button" disabled={forceLoading || !forceZoneIds.length} onClick={handleForce}>
          {forceLoading ? 'Запускаем...' : 'Запустить полив'}
        </button>
      </div>

      {durationLabel && <div className="pill">Длительность: {durationLabel}</div>}
      {forceStatus.text && <div className={`pill ${forceStatus.type}`}>{forceStatus.text}</div>}

      <ZoneGroup title="Гидропоника" zones={grouped.hydro} maxColumns={maxColumns} />
      <ZoneGroup title="Аэропоника" zones={grouped.aero} maxColumns={maxColumns} />
      <ZoneGroup title="Другое" zones={grouped.other} maxColumns={maxColumns} />
    </div>
  );
}
