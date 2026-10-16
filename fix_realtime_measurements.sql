SET GLOBAL event_scheduler = ON;

DROP EVENT IF EXISTS insert_fake_measurements;
DROP EVENT IF EXISTS insert_fake_measurements_2;

DELIMITER //

CREATE EVENT insert_fake_measurements
ON SCHEDULE EVERY 2 SECOND
STARTS CURRENT_TIMESTAMP
ON COMPLETION NOT PRESERVE
ENABLE
DO
BEGIN
  DECLARE v_temp DOUBLE DEFAULT 23;
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

  SET v_temp = LEAST(25, GREATEST(22, IFNULL(v_temp, 23.5) + (23.5 - IFNULL(v_temp, 23.5)) * 0.03 + (RAND() - 0.5) * 0.16));
  SET v_humidity = LEAST(
    80,
    GREATEST(
      70,
      IFNULL(v_humidity, 75)
        + (75 - IFNULL(v_humidity, 75)) * 0.04
        + (RAND() - 0.5) * 0.9
    )
  );
  SET v_co2 = LEAST(1500, GREATEST(1000, IFNULL(v_co2, 1250) + (1250 - IFNULL(v_co2, 1250)) * 0.03 + (RAND() - 0.5) * 24));

  INSERT INTO plants.sensors_measurements (id_sensors, id_parameter, value, id_zone)
  VALUES
    ((SELECT id_sensor FROM plants.sensors WHERE id_parameterss = 1 ORDER BY id_sensor LIMIT 1), 1, ROUND(v_temp, 1), NULL),
    ((SELECT id_sensor FROM plants.sensors WHERE id_parameterss = 2 ORDER BY id_sensor LIMIT 1), 2, ROUND(v_humidity, 1), NULL),
    ((SELECT id_sensor FROM plants.sensors WHERE id_parameterss = 3 ORDER BY id_sensor LIMIT 1), 3, ROUND(v_co2, 0), NULL);

  BEGIN
    DECLARE done INT DEFAULT 0;
    DECLARE v_zone INT;
    DECLARE v_tech INT;
    DECLARE v_ec DOUBLE;

    DECLARE cur CURSOR FOR
      SELECT id_zone, id_technolog
      FROM plants.zones;

    DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;

    OPEN cur;

    zone_loop: LOOP
      FETCH cur INTO v_zone, v_tech;
      IF done = 1 THEN
        LEAVE zone_loop;
      END IF;

      IF v_tech = 1 THEN
        SET v_ec = (
          SELECT value
          FROM plants.sensors_measurements
          WHERE id_parameter = 6 AND id_zone = v_zone
          ORDER BY `timestamp` DESC
          LIMIT 1
        );
        SET v_ec = LEAST(2.2, GREATEST(1.6, IFNULL(v_ec, 1.9) + (RAND() - 0.5) * 0.06));

        INSERT INTO plants.sensors_measurements (id_sensors, id_parameter, value, id_zone)
        VALUES
          ((SELECT id_sensor FROM plants.sensors WHERE id_parameterss = 4 ORDER BY id_sensor LIMIT 1), 4, ROUND(5.9 + RAND() * 0.2, 2), v_zone),
          ((SELECT id_sensor FROM plants.sensors WHERE id_parameterss = 6 ORDER BY id_sensor LIMIT 1), 6, ROUND(v_ec, 2), v_zone);
      ELSEIF v_tech = 2 THEN
        SET v_ec = (
          SELECT value
          FROM plants.sensors_measurements
          WHERE id_parameter = 6 AND id_zone = v_zone
          ORDER BY `timestamp` DESC
          LIMIT 1
        );
        SET v_ec = LEAST(2.2, GREATEST(1.6, IFNULL(v_ec, 1.9) + (RAND() - 0.5) * 0.05));

        INSERT INTO plants.sensors_measurements (id_sensors, id_parameter, value, id_zone)
        VALUES
          ((SELECT id_sensor FROM plants.sensors WHERE id_parameterss = 7 ORDER BY id_sensor LIMIT 1), 7, ROUND(95 + RAND() * 5, 1), v_zone),
          ((SELECT id_sensor FROM plants.sensors WHERE id_parameterss = 6 ORDER BY id_sensor LIMIT 1), 6, ROUND(v_ec, 2), v_zone);
      END IF;
    END LOOP;

    CLOSE cur;
  END;
END//

DELIMITER ;
