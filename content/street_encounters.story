{node street_pickpocket}

A kid bumps into you hard, and his hand is already in your coat.

{>}
Grab his wrist
{then}
    He yelps and twists free, and is gone.
    {do pickpocketed = true}
    {do return}


{node street_shakedown}

Two men step out of a doorway and block the street.

{>}
Hand over your money
{then}
    They take it and let you pass.
    {do return}

{>}
Run
{then}
    {do goto street_alley}


{node street_alley}

A dead-end alley. They're right behind you.

{>}
Give up
{then}
    The cuffs go on.
    {do return}

{>}
Talk your way out
{then}
    They laugh, but let you go.
    {do return}


{node docks_dockworker}

A dockworker with a crowbar asks what you're doing here.

{>}
Say you're lost
{then}
    He points the way out.
    {do return}
