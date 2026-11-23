------------------ MODULE ScheduledBlog ------------------
EXTENDS Naturals, TLC

Statuses == {"draft", "scheduled", "publishing", "published", "deleted"}
Versions == 0..2
Attempts == 0..2

VARIABLES status, due, claimed, version, claimVersion, attempts
vars == <<status, due, claimed, version, claimVersion, attempts>>

Init ==
  /\ status = "draft"
  /\ due = FALSE
  /\ claimed = FALSE
  /\ version = 0
  /\ claimVersion = 0
  /\ attempts = 0

SaveDraft ==
  /\ version < 2
  /\ status # "published"
  /\ status' = "draft"
  /\ due' = FALSE
  /\ claimed' = FALSE
  /\ version' = version + 1
  /\ claimVersion' = version + 1
  /\ UNCHANGED attempts

SchedulePost ==
  /\ version < 2
  /\ status \in {"draft", "scheduled", "publishing", "deleted"}
  /\ status' = "scheduled"
  /\ due' = FALSE
  /\ claimed' = FALSE
  /\ version' = version + 1
  /\ claimVersion' = version + 1
  /\ UNCHANGED attempts

DueTimeArrives ==
  /\ status = "scheduled"
  /\ ~due
  /\ due' = TRUE
  /\ UNCHANGED <<status, claimed, version, claimVersion, attempts>>

ClaimDuePost ==
  /\ status = "scheduled"
  /\ due
  /\ ~claimed
  /\ status' = "publishing"
  /\ claimed' = TRUE
  /\ claimVersion' = version
  /\ UNCHANGED <<due, version, attempts>>

PublishFailed ==
  /\ status = "publishing"
  /\ claimed
  /\ claimVersion = version
  /\ attempts < 2
  /\ status' = "scheduled"
  /\ claimed' = FALSE
  /\ attempts' = attempts + 1
  /\ UNCHANGED <<due, version, claimVersion>>

PublishSucceeded ==
  /\ status = "publishing"
  /\ claimed
  /\ claimVersion = version
  /\ status' = "published"
  /\ claimed' = FALSE
  /\ UNCHANGED <<due, version, claimVersion, attempts>>

DeletePost ==
  /\ status \in {"draft", "scheduled", "publishing"}
  /\ status' = "deleted"
  /\ claimed' = FALSE
  /\ UNCHANGED <<due, version, claimVersion, attempts>>

Next ==
  \/ SaveDraft
  \/ SchedulePost
  \/ DueTimeArrives
  \/ ClaimDuePost
  \/ PublishFailed
  \/ PublishSucceeded
  \/ DeletePost

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ status \in Statuses
  /\ due \in BOOLEAN
  /\ claimed \in BOOLEAN
  /\ version \in Versions
  /\ claimVersion \in Versions
  /\ attempts \in Attempts

ClaimOnlyWhilePublishing ==
  claimed => status = "publishing"

ClaimBoundToVersion ==
  claimed => claimVersion = version

===========================================================
