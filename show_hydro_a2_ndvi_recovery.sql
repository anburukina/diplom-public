ALTER EVENT plants.generate_hydro_a2_ndvi_event DISABLE;

INSERT INTO plants.ndvi_scenario_state
  (scenario_name, id_zone, phase, step_index, started_at, updated_at)
SELECT
  'hydro_a2_ndvi',
  z.id_zone,
  'NORMAL',
  23,
  NOW(),
  NOW()
FROM plants.zones z
WHERE z.id_technolog = 1
  AND (LOWER(z.zone_name) LIKE '%a2%' OR LOWER(z.zone_name) LIKE '%а2%')
ORDER BY z.id_zone
LIMIT 1
ON DUPLICATE KEY UPDATE
  id_zone = VALUES(id_zone),
  phase = 'NORMAL',
  step_index = 23,
  updated_at = NOW();

DELETE se
FROM plants.sensor_error se
JOIN plants.sensors s ON s.id_sensor = se.id_sensor_number
WHERE s.id_parameterss = 10
  AND se.error_code = 'OUT-10'
  AND se.error_name LIKE '%A2%';
