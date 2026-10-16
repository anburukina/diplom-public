SET GLOBAL event_scheduler = ON;

DELETE FROM plants.sensor_error
WHERE error_code IN (
  'OUT-1',
  'OUT-2',
  'OUT-3',
  'Warning_Hum',
  'Alarm_Hum',
  'Warning_CO2',
  'Alarm_CO2',
  'Warning_Hum_TempCorrection',
  'Warning_Hum_AboveSetpoint'
);

DROP EVENT IF EXISTS plants.insert_fake_measurements;
DROP EVENT IF EXISTS plants.insert_fake_measurements_2;
DROP EVENT IF EXISTS plants.generate_hydro_stable_ndvi_event;
DROP EVENT IF EXISTS plants.generate_aero_stable_ndvi_event;

DELIMITER $$

CREATE DEFINER=`root`@`localhost` EVENT plants.insert_fake_measurements
ON SCHEDULE EVERY 2 SECOND
STARTS CURRENT_TIMESTAMP + INTERVAL 2 SECOND
ON COMPLETION NOT PRESERVE
ENABLE
DO
BEGIN
  DECLARE v_temp DOUBLE DEFAULT 23.5;
  DECLARE v_humidity DOUBLE DEFAULT 75;
  DECLARE v_co2 DOUBLE DEFAULT 1250;

  SELECT value INTO v_temp
  FROM plants.sensors_measurements
  WHERE id_parameter = 1
  ORDER BY `timestamp` DESC
  LIMIT 1;

  SELECT value INTO v_humidity
  FROM plants.sensors_measurements
  WHERE id_parameter = 2
  ORDER BY `timestamp` DESC
  LIMIT 1;

  SELECT value INTO v_co2
  FROM plants.sensors_measurements
  WHERE id_parameter = 3
  ORDER BY `timestamp` DESC
  LIMIT 1;

  SET v_temp = LEAST(
    25,
    GREATEST(
      22,
      IFNULL(v_temp, 23.5)
        + (23.5 - IFNULL(v_temp, 23.5)) * 0.03
        + (RAND() - 0.5) * 0.16
    )
  );
  SET v_humidity = LEAST(
    80,
    GREATEST(
      70,
      IFNULL(v_humidity, 75)
        + (75 - IFNULL(v_humidity, 75)) * 0.04
        + (RAND() - 0.5) * 0.9
    )
  );
  SET v_co2 = LEAST(
    1500,
    GREATEST(
      1000,
      IFNULL(v_co2, 1250)
        + (1250 - IFNULL(v_co2, 1250)) * 0.03
        + (RAND() - 0.5) * 24
    )
  );

  INSERT INTO plants.sensors_measurements (id_sensors, id_parameter, value, id_zone)
  VALUES
    ((SELECT id_sensor FROM plants.sensors WHERE id_parameterss = 1 ORDER BY id_sensor LIMIT 1), 1, ROUND(v_temp, 1), NULL),
    ((SELECT id_sensor FROM plants.sensors WHERE id_parameterss = 2 ORDER BY id_sensor LIMIT 1), 2, ROUND(v_humidity, 1), NULL),
    ((SELECT id_sensor FROM plants.sensors WHERE id_parameterss = 3 ORDER BY id_sensor LIMIT 1), 3, ROUND(v_co2, 0), NULL);
END$$

DROP PROCEDURE IF EXISTS plants.generate_hydro_stable_ndvi_tick$$
DROP PROCEDURE IF EXISTS plants.generate_aero_stable_ndvi_tick$$

CREATE PROCEDURE plants.generate_hydro_stable_ndvi_tick()
BEGIN
  DECLARE v_zone_id INT;
  DECLARE v_zone_name VARCHAR(255);
  DECLARE v_sensor_id INT DEFAULT NULL;
  DECLARE v_ts DATETIME;
  DECLARE v_hour INT;
  DECLARE v_base DOUBLE;
  DECLARE v_value DOUBLE;
  DECLARE done INT DEFAULT 0;

  DECLARE cur CURSOR FOR
    SELECT id_zone, zone_name
    FROM plants.zones
    WHERE id_technolog = 1
      AND NOT EXISTS (
        SELECT 1
        FROM plants.ndvi_scenario_state s
        WHERE s.scenario_name = 'hydro_a2_ndvi'
          AND s.id_zone = plants.zones.id_zone
          AND s.phase IN ('DECLINE', 'RECOVERY')
      )
    ORDER BY id_zone;

  DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;

  SELECT id_sensor INTO v_sensor_id
  FROM plants.sensors
  WHERE id_parameterss = 10
  ORDER BY id_sensor
  LIMIT 1;

  IF v_sensor_id IS NOT NULL THEN
    SET v_ts = TIMESTAMP(DATE_FORMAT(NOW(), '%Y-%m-%d %H:00:00'));
    SET v_hour = TIMESTAMPDIFF(HOUR, '2026-01-01 00:00:00', v_ts);

    OPEN cur;
    read_loop: LOOP
      FETCH cur INTO v_zone_id, v_zone_name;
      IF done = 1 THEN
        LEAVE read_loop;
      END IF;

      SET v_base = CASE
        WHEN LOWER(v_zone_name) LIKE '%a1%' OR LOWER(v_zone_name) LIKE '%а1%' THEN 0.620
        WHEN LOWER(v_zone_name) LIKE '%a2%' OR LOWER(v_zone_name) LIKE '%а2%' THEN 0.640
        WHEN LOWER(v_zone_name) LIKE '%a3%' OR LOWER(v_zone_name) LIKE '%а3%' THEN 0.660
        WHEN LOWER(v_zone_name) LIKE '%a4%' OR LOWER(v_zone_name) LIKE '%а4%' THEN 0.680
        ELSE 0.650
      END;
      SET v_value = ROUND(LEAST(0.75, GREATEST(0.5, v_base + SIN(v_hour / 4) * 0.006)), 3);

      DELETE FROM plants.sensors_measurements
      WHERE id_parameter = 10
        AND id_zone = v_zone_id
        AND `timestamp` = v_ts;

      DELETE FROM plants.ndvi
      WHERE id_zone = v_zone_id
        AND `timestamp` = v_ts;

      INSERT INTO plants.sensors_measurements
        (id_sensors, id_parameter, value, id_zone, id_run, `timestamp`)
      VALUES
        (v_sensor_id, 10, v_value, v_zone_id, NULL, v_ts);

      INSERT INTO plants.ndvi (id_zone, ndvi_value, `timestamp`)
      VALUES (v_zone_id, v_value, v_ts);
    END LOOP;
    CLOSE cur;
  END IF;
END$$

CREATE PROCEDURE plants.generate_aero_stable_ndvi_tick()
BEGIN
  DECLARE v_zone_id INT;
  DECLARE v_sensor_id INT DEFAULT NULL;
  DECLARE v_ts DATETIME;
  DECLARE v_hour INT;
  DECLARE v_base DOUBLE;
  DECLARE v_value DOUBLE;
  DECLARE done INT DEFAULT 0;

  DECLARE cur CURSOR FOR
    SELECT id_zone
    FROM plants.zones
    WHERE id_technolog = 2
    ORDER BY id_zone;

  DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;

  SELECT id_sensor INTO v_sensor_id
  FROM plants.sensors
  WHERE id_parameterss = 11
  ORDER BY id_sensor
  LIMIT 1;

  IF v_sensor_id IS NOT NULL THEN
    SET v_ts = TIMESTAMP(DATE_FORMAT(NOW(), '%Y-%m-%d %H:00:00'));
    SET v_hour = TIMESTAMPDIFF(HOUR, '2026-01-01 00:00:00', v_ts);

    OPEN cur;
    read_loop: LOOP
      FETCH cur INTO v_zone_id;
      IF done = 1 THEN
        LEAVE read_loop;
      END IF;

      SET v_base = CASE MOD(v_zone_id, 3)
        WHEN 0 THEN 0.655
        WHEN 1 THEN 0.635
        ELSE 0.675
      END;
      SET v_value = ROUND(
        LEAST(
          0.75,
          GREATEST(
            0.5,
            v_base
              + SIN((v_hour + v_zone_id) / 5) * 0.006
              + COS((v_hour + v_zone_id * 2) / 7) * 0.004
          )
        ),
        3
      );

      DELETE FROM plants.sensors_measurements
      WHERE id_parameter = 11
        AND id_zone = v_zone_id
        AND `timestamp` = v_ts;

      DELETE FROM plants.ndvi
      WHERE id_zone = v_zone_id
        AND `timestamp` = v_ts;

      INSERT INTO plants.sensors_measurements
        (id_sensors, id_parameter, value, id_zone, id_run, `timestamp`)
      VALUES
        (v_sensor_id, 11, v_value, v_zone_id, NULL, v_ts);

      INSERT INTO plants.ndvi (id_zone, ndvi_value, `timestamp`)
      VALUES (v_zone_id, v_value, v_ts);
    END LOOP;
    CLOSE cur;
  END IF;
END$$

CREATE EVENT plants.generate_hydro_stable_ndvi_event
ON SCHEDULE EVERY 1 HOUR
STARTS CURRENT_TIMESTAMP + INTERVAL 1 SECOND
ON COMPLETION NOT PRESERVE
ENABLE
DO
  CALL plants.generate_hydro_stable_ndvi_tick()$$

CREATE EVENT plants.generate_aero_stable_ndvi_event
ON SCHEDULE EVERY 1 HOUR
STARTS CURRENT_TIMESTAMP + INTERVAL 1 SECOND
ON COMPLETION NOT PRESERVE
ENABLE
DO
  CALL plants.generate_aero_stable_ndvi_tick()$$

DELIMITER ;

CALL plants.generate_hydro_stable_ndvi_tick();
CALL plants.generate_aero_stable_ndvi_tick();
