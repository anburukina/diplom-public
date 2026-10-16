SET GLOBAL event_scheduler = ON;

ALTER EVENT plants.generate_hydro_a2_ndvi_event ENABLE;

CALL plants.start_hydro_a2_ndvi_decline_scenario();
