{node mission_1_exterior}
{var searched_alley = false}
{var tried_maintenance_door = false}
{var maintenance_door_unlocked = false}
You approach the apartment building, four stories of corroded grey metal. The laptop must be somewhere in here.

The front entrance, a heavy metal door, is slightly ajar.

A narrow alley leads around the right side of the building.

{>} Use the main entrance
{then}
The metal door groans as you pull it open and slip inside.

{> if not searched_alley} Enter the alley
{then}
You follow the path around the side of the building, under the light of a glowing orange lamp. You see two large dumpsters, and beside them, a metal door with a sign that reads: **"Maintenance Access - No Trespassing"**.
{do searched_alley = true}

{> if searched_alley and not tried_maintenance_door} Try the maintenance door
{then}
You pull on the door. It's locked.
{do tried_maintenance_door = true}

{> if tried_maintenance_door and not maintenance_door_unlocked} Pick the maintenance door lock
{then}
You deftly shift the pins of the lock, and it clicks open.
{do maintenance_door_unlocked = true}