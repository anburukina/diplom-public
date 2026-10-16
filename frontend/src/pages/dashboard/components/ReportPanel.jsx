import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { NDVI_COMPARE_KEY, NDVI_COMPARE_LABEL, REPORT_PALETTE } from '../constants';
import { formatNumber } from '../../../utils/format';

/** Отображение графика отчетности и выбора параметра. */
export function ReportPanel({
  flags,
  formatReportLabel,
  labelMap,
  onReportParamChange,
  parameters,
  report,
  reportChart,
  reportError,
  reportLoading,
  reportParam,
}) {
  return (
    <div className="panel dashboard-panel">
      <div className="card-row dashboard-panel-heading">
        <h3>Отчетность</h3>
      </div>
      <div className="grid cols-2 report-grid report-panel-grid">
        <div className="chart-wrap report-chart">
          <div className="card-row report-chart-heading">
            <div className="list-inline">
              <span className="pill">Параметр: {report?.name ?? '-'}</span>
              <span className="pill">Точек: {reportChart.rows.length}</span>
            </div>
          </div>
          <ResponsiveContainer>
            <LineChart data={reportChart.rows} margin={{ top: 10, left: 0, right: 0, bottom: 20 }}>
              <CartesianGrid stroke="#1f2c3f" strokeDasharray="3 3" />
              <XAxis
                dataKey={flags.reportIsDense ? 'x' : 'ts'}
                type="number"
                scale={flags.reportIsDense ? 'linear' : 'time'}
                domain={['dataMin', 'dataMax']}
                tickCount={flags.reportIsDense ? Math.min(6, reportChart.rows.length) : 6}
                minTickGap={flags.reportIsDense ? 10 : 40}
                allowDuplicatedCategory={false}
                stroke="#93a3be"
                tickFormatter={(value) => {
                  if (flags.reportIsDense) return labelMap?.get(value) || value;
                  return formatReportLabel(value);
                }}
              />
              <YAxis stroke="#93a3be" />
              <Tooltip
                contentStyle={{ background: '#0f1724', border: '1px solid var(--border)' }}
                formatter={(value) => formatNumber(value, 1)}
                labelFormatter={formatReportLabel}
              />
              {reportChart.seriesKeys.map((key, idx) => (
                <Line
                  key={key}
                  type="monotone"
                  dataKey={key}
                  stroke={REPORT_PALETTE[idx % REPORT_PALETTE.length]}
                  dot={false}
                  name={reportChart.seriesLabels.get(key) || 'Значение'}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
          {reportLoading && <div className="muted report-chart-note">Загрузка...</div>}
          {!reportLoading && !reportChart.rows.length && <div className="muted report-chart-note">Нет данных</div>}
        </div>
        <div>
          <div className="card-row report-select-row">
            <div className="subtitle">Выбор параметра</div>
            <select className="input" value={reportParam} onChange={(e) => onReportParamChange(e.target.value)}>
              {parameters.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name || p.id}
                </option>
              ))}
              <option value={NDVI_COMPARE_KEY}>{NDVI_COMPARE_LABEL}</option>
            </select>
          </div>
          {reportError && <div className="pill danger">{reportError}</div>}
        </div>
      </div>
    </div>
  );
}
