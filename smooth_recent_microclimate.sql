ALTER EVENT insert_fake_measurements DISABLE;

DELETE FROM sensors_measurements
WHERE id_parameter IN (1, 2, 3)
  AND `timestamp` >= NOW() - INTERVAL 10 MINUTE;

INSERT INTO sensors_measurements (id_sensors, id_parameter, value, id_zone, `timestamp`)
WITH RECURSIVE seq(n, ts) AS (
  SELECT 0, DATE_SUB(NOW(), INTERVAL 10 MINUTE)
  UNION ALL
  SELECT n + 1, DATE_ADD(ts, INTERVAL 2 SECOND)
  FROM seq
  WHERE n < 300
)
SELECT (SELECT id_sensor FROM sensors WHERE id_parameterss = 1 ORDER BY id_sensor LIMIT 1), 1, ROUND(23.5 + SIN((n - 300) / 42) * 0.25 + SIN((n - 300) / 13) * 0.03, 1), NULL, ts FROM seq
UNION ALL
SELECT (SELECT id_sensor FROM sensors WHERE id_parameterss = 2 ORDER BY id_sensor LIMIT 1), 2,
  ROUND(
    75
      + SIN((n - 300) / 73) * 0.45
      + SIN((n - 300) / 29) * 0.18
      + (RAND(n * 17 + 2) - 0.5) * 0.55,
    1
  ), NULL, ts FROM seq
UNION ALL
SELECT (SELECT id_sensor FROM sensors WHERE id_parameterss = 3 ORDER BY id_sensor LIMIT 1), 3, ROUND(1250 + SIN((n - 300) / 44) * 28 + SIN((n - 300) / 14) * 2, 0), NULL, ts FROM seq;

ALTER EVENT insert_fake_measurements ENABLE;
