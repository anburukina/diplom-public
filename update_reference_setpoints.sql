INSERT INTO units (id_unit, unit_name)
VALUES
  (1, '%'),
  (2, '°C'),
  (3, 'Ppm (миллионнная доля)'),
  (5, 'pH'),
  (6, 'мС/см'),
  (7, '—')
ON DUPLICATE KEY UPDATE
  unit_name = VALUES(unit_name);

UPDATE reference_values
SET min_value = 22, max_value = 25
WHERE id_parameters = 1;

UPDATE reference_values
SET min_value = 70, max_value = 80
WHERE id_parameters = 2;

UPDATE reference_values
SET min_value = 1000, max_value = 1500
WHERE id_parameters = 3;

INSERT INTO parameters (id_parameter, id_unit, name_parameter, id_stage)
VALUES
  (4, 5, 'Кислотность раствора (pH)', 1),
  (6, 6, 'Электропроводность раствора (EC)', 1),
  (7, 1, 'Влажность в зоне корней', 2)
ON DUPLICATE KEY UPDATE
  id_unit = VALUES(id_unit),
  name_parameter = VALUES(name_parameter),
  id_stage = VALUES(id_stage);

INSERT INTO reference_values (id_reference_values, id_parameters, min_value, max_value, id_unit_values)
VALUES
  (4, 4, 5.8, 6.2, 5),
  (6, 6, 1.6, 2.2, 6),
  (7, 7, 95, 100, 1)
ON DUPLICATE KEY UPDATE
  id_parameters = VALUES(id_parameters),
  min_value = VALUES(min_value),
  max_value = VALUES(max_value),
  id_unit_values = VALUES(id_unit_values);

UPDATE reference_values
SET min_value = 0.5, max_value = 0.75
WHERE id_parameters IN (10, 11);
