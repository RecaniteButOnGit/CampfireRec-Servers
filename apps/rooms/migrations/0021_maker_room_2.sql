-- Seed the blank Rooms 2.0 creation template into databases that already applied
-- 0002_import_rooms.sql. The canonical source is static/ImportRooms.json.
-- The subroom id is minted here because live databases may already use id 64.
-- Its unsaved subroom reuses the blank MakerRoom scene shipped by this repository.

INSERT OR IGNORE INTO room (data) VALUES ('{"RoomId":46,"Name":"MakerRoom2","Description":"An empty Rooms 2.0 room for building whatever you like.","ImageName":"MakerRoom.jpg","WarningMask":0,"CustomWarning":null,"CreatorAccountId":1,"State":0,"Accessibility":2,"PublishState":0,"SupportsLevelVoting":false,"IsRRO":true,"IsRecRoomApproved":false,"ExcludeFromLists":false,"ExcludeFromSearch":false,"SupportsScreens":true,"SupportsWalkVR":true,"SupportsTeleportVR":true,"SupportsVRLow":true,"SupportsQuest2":true,"SupportsMobile":true,"SupportsJuniors":true,"MinLevel":0,"AgeRating":2,"CreatedAt":"2026-03-11T06:48:51.328171Z","PublishedAt":"2026-03-11T06:48:51.328171Z","BecameRRStudioRoomAt":null,"Stats":{"CheerCount":0,"FavoriteCount":0,"VisitorCount":0,"VisitCount":0},"RankingContext":null,"IsDorm":false,"IsPlacePlay":false,"MaxPlayerCalculationMode":0,"MaxPlayers":20,"CloningAllowed":true,"DisableMicAutoMute":false,"DisableRoomComments":false,"EncryptVoiceChat":false,"ToxmodEnabled":true,"LoadScreenLocked":false,"UgcVersion":2,"PersistenceVersion":0,"UgcSubVersion":null,"MinUgcSubVersion":null,"AutoLocalizeRoom":false,"LocalizationContext":{"TargetLocale":null,"Scope":null,"LocalizedFields":["Description","CustomWarning"]},"IsDeveloperOwned":true,"RankedEntityId":"46","Roles":[{"AccountId":1,"Role":255,"LastChangedByAccountId":null,"InvitedRole":0},{"AccountId":2,"Role":30,"LastChangedByAccountId":null,"InvitedRole":0}],"IsJuniorCreated":false,"PromoImages":[],"PromoExternalContent":[],"LoadScreens":[],"RestrictedCircuitsAllowListNames":[]}');

INSERT INTO subroom (room_id, data)
  SELECT 46, '{"RoomId":46,"CreatorAccountId":null,"UnitySceneId":"a75f7547-79eb-47c6-8986-6767abcb4f92","Name":"Home","LastModeratedSaveModerationState":0,"IsSandbox":true,"MaxPlayers":20,"Accessibility":2,"ShouldAutoStageSaves":true}'
  WHERE EXISTS (SELECT 1 FROM room WHERE room_id = 46 AND name = 'MakerRoom2')
    AND NOT EXISTS (SELECT 1 FROM subroom WHERE room_id = 46);

INSERT OR IGNORE INTO room_tag (room_id, tag, type, is_primary_genre)
  SELECT 46, 'rro', 2, 0 WHERE EXISTS (SELECT 1 FROM room WHERE room_id = 46 AND name = 'MakerRoom2');
INSERT OR IGNORE INTO room_tag (room_id, tag, type, is_primary_genre)
  SELECT 46, 'base', 0, 0 WHERE EXISTS (SELECT 1 FROM room WHERE room_id = 46 AND name = 'MakerRoom2');
INSERT OR IGNORE INTO room_tag (room_id, tag, type, is_primary_genre)
  SELECT 46, 'beta', 1, 0 WHERE EXISTS (SELECT 1 FROM room WHERE room_id = 46 AND name = 'MakerRoom2');
