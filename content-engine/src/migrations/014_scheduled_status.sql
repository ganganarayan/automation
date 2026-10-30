-- A ready video handed to Post for Me is 'scheduled' until Post for Me reports
-- it published; only then is it 'posted' (and locked). Until then it stays
-- editable: editing deletes the scheduled post and returns it to a draft.
-- Fix rows locked as posted whose post time is still in the future. Additive.

UPDATE instances
   SET status = 'scheduled', post_status = 'scheduled', locked = false
 WHERE status = 'posted'
   AND posted_at > now()
   AND source_type IN ('drive_folder', 'drive_pick');
