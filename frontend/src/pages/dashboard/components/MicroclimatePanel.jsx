import { Area, CartesianGrid, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { MICRO_METRICS } from '../constants';
import { formatTimeTick } from '../timelineUtils';
import { formatNumber } from '../../../utils/format';

/** Отображение графиков температуры, влажности и CO2. */
export function MicroclimatePanel({ chartData }) {
  return (
    <div className="panel dashboard-panel">
      <div className="card-row dashboard-panel-heading">
        <h3>Микроклимат</h3>
      </div>
      <div className="grid cols-3">
        {MICRO_METRICS.map((metric) => {
          const alertValueKey = `${metric.key}AlertValue`;
          const metricData = chartData.filter((row) => row[metric.key] != null || row[alertValueKey] != null);

          return (
            <div key={metric.key} className="chart-wrap micro-chart">
              <div className="muted micro-chart-title">{metric.label}</div>
              <ResponsiveContainer>
                <ComposedChart data={metricData}>
                  <CartesianGrid stroke="#1f2c3f" strokeDasharray="3 3" />
                  <XAxis dataKey="ts" stroke="#93a3be" tickFormatter={formatTimeTick} />
                  <YAxis stroke="#93a3be" />
                  <Tooltip
                    contentStyle={{ background: '#0f1724', border: '1px solid var(--border)' }}
                    formatter={(value, name) => [
                      formatNumber(value, 1),
                      name === 'Warning' ? 'Предупреждение' : name === 'Alarm' ? 'Тревога' : name,
                    ]}
                    labelFormatter={formatTimeTick}
                  />
                  <Area
                    type="monotone"
                    dataKey={metric.key}
                    connectNulls
                    stroke={metric.stroke}
                    strokeWidth={2}
                    fill={metric.fill}
                    isAnimationActive={false}
                    name={metric.label}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          );
        })}
      </div>
    </div>
  );
}
