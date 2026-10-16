SET GLOBAL event_scheduler = ON;

DROP EVENT IF EXISTS plants.generate_root_humidity_measurements;

DELIMITER $$

CREATE EVENT plants.generate_root_humidity_measurements
ON SCHEDULE EVERY 10 SECOND
STARTS CURRENT_TIMESTAMP + INTERVAL 10 SECOND
ON COMPLETION NOT PRESERVE
ENABLE
DO
BEGIN
  DECLARE v_sensor_id INT DEFAULT NULL;
  DECLARE v_zone_id INT DEFAULT NULL;
  DECLARE v_min DOUBLE DEFAULT 95;
  DECLARE v_max DOUBLE DEFAULT 100;
  DECLARE v_target DOUBLE DEFAULT 97.5;
  DECLARE v_last DOUBLE DEFAULT 97.5;
  DECLARE v_value DOUBLE DEFAULT 97.5;
  DECLARE done INT DEFAULT 0;

  DECLARE cur CURSOR FOR
    SELECT id_zone
    FROM plants.zones
    ORDER BY id_zone;

  DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;

  SELECT (
    SELECT id_sensor
    FROM plants.sensors
    WHERE id_parameterss = 7
    ORDER BY id_sensor
    LIMIT 1
  ) INTO v_sensor_id;

  SELECT
    COALESCE((SELECT min_value FROM plants.reference_values WHERE id_parameters = 7 LIMIT 1), v_min),
    COALESCE((SELECT max_value FROM plants.reference_values WHERE id_parameters = 7 LIMIT 1), v_max)
  INTO v_min, v_max;

  SET v_target = (v_min + v_max) / 2;

  IF v_sensor_id IS NOT NULL THEN
    OPEN cur;
    read_loop: LOOP
      FETCH cur INTO v_zone_id;
      IF done = 1 THEN
        LEAVE read_loop;
      END IF;

      SELECT COALESCE(
        (
          SELECT value
          FROM plants.sensors_measurements
          WHERE id_parameter = 7
            AND id_zone = v_zone_id
          ORDER BY `timestamp` DESC
          LIMIT 1
        ),
        v_target
      ) INTO v_last;

      SET v_value = LEAST(
        v_max,
        GREATEST(
          v_min,
          IFNULL(v_last, v_target)
            + (v_target - IFNULL(v_last, v_target)) * 0.12
            + (RAND() - 0.5) * 1.4
        )
      );

      INSERT INTO plants.sensors_measurements
        (id_sensors, id_parameter, value, id_zone, `timestamp`)
      VALUES
        (v_sensor_id, 7, ROUND(v_value, 1), v_zone_id, NOW());
    END LOOP;
    CLOSE cur;
  END IF;
END$$

DELIMITER ;
