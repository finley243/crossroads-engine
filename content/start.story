{node start}
Welcome to the start of the game. This is a temporary starting node for development purposes.

{>} Begin Mission
{then}
{do mission_1_started = true}
{do goto mission_1_exterior}

{> roll 50} Roll Test
{then success}
The roll succeeded.
{then failure}
The roll failed.