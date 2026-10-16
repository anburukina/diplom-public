/** Отображение значения параметра и подсветка выхода за допустимый диапазон. */
export function Value({ value, unit, refRange }) {
  const outOfRange = refRange && (value < refRange[0] || value > refRange[1]);
  return (
    <div className={outOfRange ? 'chip danger' : 'chip success'}>
      {value}
      {unit && <span style={{ marginLeft: 6, color: 'var(--muted)' }}>{unit}</span>}
    </div>
  );
}
