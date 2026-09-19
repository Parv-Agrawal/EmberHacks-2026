--------------------------------------------------------------------------------
ID       : 1
TYPE     : USER STORY : [ASSIGNED] : [STATUS]
Name     : Implement threshold squat depth
PRIORITY : 3
ESTIMATE : 4 hours   ACTUAL : 
AS A     : USER
I WANT   : the app to correctly tell me when I've hit proper squat depth
SO THAT  : the feedback isn't based on a guessed angle that might be wrong for user's body
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
ID       : 2
TYPE     : USER STORY : [ASSIGNED] : [STATUS]
Name     : Add rep counter state machine
PRIORITY : 3
ESTIMATE : 4 hours   ACTUAL :
AS A     : USER
I WANT   : my reps to be counted automatically as I squat
SO THAT  : I can track a full set, not just get feedback on a single frame
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
ID       : 3
TYPE     : USER STORY : [ASSIGNED] : [STATUS]
Name     : Add back-angle check
PRIORITY : 3
ESTIMATE : 3 hours   ACTUAL :
AS A     : USER
I WANT   : the app to check my back stays flat, not just my knee angle
SO THAT  : my repition is more effective and according to the correct form
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
ID       : 4.001
TYPE     : USER STORY : [ASSIGNED] : [STATUS]
Name     : Base Exercise Template
PRIORITY : 1
ESTIMATE : 2 hours   ACTUAL :
AS A     : DEVELOPER
I WANT   : A base class template for exercises.
SO THAT  : Any exercise I add later follows the same consistent rules.
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
ID       : 6.002
TYPE     : USER STORY : [ASSIGNED] : [STATUS]
Name     : MediaPipe Pose Integration
PRIORITY : 2
ESTIMATE : 2 hours   ACTUAL :
AS A     : DEVELOPER
I WANT   : To initialize the MediaPipe Pose model on the video feed.
SO THAT  : The computer can identify human body landmarks.
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
ID       : 6.003
TYPE     : USER STORY : [ASSIGNED] : [STATUS]
Name     : Live Skeleton Overlay
PRIORITY : 3
ESTIMATE : 2 hours   ACTUAL :
AS A     : DEVELOPER
I WANT   : To draw skeletal lines over the video. this is wrking i think but dont know how if you can see if the implementation is actually accurate for our purpouse
SO THAT  : The user knows the computer is successfully tracking them.
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
ID       : 6.004
TYPE     : USER STORY : [ASSIGNED] : [STATUS]
Name     : Landmark Data Pipeline
PRIORITY : 4
ESTIMATE : 2 hours   ACTUAL :
AS A     : DEVELOPER
I WANT   : To send landmark coordinates from video to the math engine.
SO THAT  : The exercise plugins can perform calculations.
--------------------------------------------------------------------------------

