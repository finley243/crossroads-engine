{node start}
{var searched = false}
{location alley}

Rain hammers the alley behind the noodle bar. A steel door is set into
the wall, and next to it, a vending machine hums and flickers.

{> if not searched}
Search the dumpster
{then}
    You dig through wet cardboard and find a **rusty crowbar**.
    {do give_item crowbar}
    {do searched = true}

{>}
Visit the vending machine
{then}
    {push vending}
        The vending machine goes back to flickering.
    {endpush}

{> if item(force) as c and not door_open, roll even}
[{c.name}] Force the door open
{then}
    {success}
        You wedge the {c.short} into the frame and lean on it. The lock gives
        with a crack that echoes down the alley.
        {do door_open = true}
        {do goto inside pause}
    {failure}
        The {c.short} slips and you slam your knuckles into the steel.
        {do mood = shaken}

{>}
Leave the alley
{then}
    {do open_map city}

{> if not door_open}
Knock
{then}
    You knock. Nobody answers. Somewhere inside, a radio plays something
    *very* old.


{node vending}
{theme netrun}

The machine's screen reads: CREDITS: {credits}.

{> if credits >= 3}
Buy a stim (3 credits)
{then}
    The machine spits out a stim, and you pocket it.
    {do credits -= 3}
    {do give_item stim}

{>} Step away {then}
    {do return}


{node inside}
{var read = false}

The room beyond the door is dark and smells of solder. A single monitor
glows on a desk, still logged in.
{if mood == shaken}
Your knuckles are still throbbing.
{endif}
{if count(stim) > 0}
At least you've got {count(stim)} stim in your pocket, just in case.
{endif}

{> if not read}
Read the monitor
{then}
    It's a message, half-written: *"If anyone finds this, don't trust the
    noodle guy."*

    That's where this example ends.
    {do read = true}