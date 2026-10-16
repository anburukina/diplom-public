SET GLOBAL event_scheduler = ON;

CREATE TABLE IF NOT EXISTS plants.ndvi (
  id_ndvi BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  id_zone INT NOT NULL,
  ndvi_value DOUBLE NOT NULL,
  `timestamp` DATETIME NOT NULL,
  INDEX idx_ndvi_zone_timestamp (id_zone, `timestamp`)
);

CREATE TABLE IF NOT EXISTS plants.ndvi_scenario_state (
  scenario_name VARCHAR(64) PRIMARY KEY,
  id_zone INT NULL,
  phase ENUM('DECLINE','RECOVERY','NORMAL') NOT NULL DEFAULT 'DECLINE',
  step_index INT NOT NULL DEFAULT 0,
  started_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL
);

DROP PROCEDURE IF EXISTS plants.generate_hydro_stable_ndvi_tick;
DROP EVENT IF EXISTS plants.generate_hydro_stable_ndvi_event;

DELIMITER $$

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

CREATE DEFINER=`root`@`localhost` EVENT plants.generate_hydro_stable_ndvi_event
ON SCHEDULE EVERY 1 HOUR
STARTS CURRENT_TIMESTAMP + INTERVAL 1 HOUR
ON COMPLETION NOT PRESERVE
ENABLE
DO
BEGIN
  CALL plants.generate_hydro_stable_ndvi_tick();
END$$

DELIMITER ;
