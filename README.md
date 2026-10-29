# RecFlare

<img width="1063" height="409" alt="image" src="https://github.com/user-attachments/assets/521d5b11-fb93-4900-9158-71d51d2343ae" />

![badge](https://github.com/djdevin/recflare/actions/workflows/test.yml/badge.svg?branch=main)

RecFlare is a scalable implementation of RecNet — the Rec Room backend — built on
Cloudflare Workers. It implements the network services the Rec Room client talks
to — accounts, auth, rooms, matchmaking, economy, chat, notifications, and more —
each as an independent Node.js Worker on their own subdomains, just how RecNet was.

> ⚠️ **Disclaimer:** This is an unofficial, fan-made project for preservation and
> experimentation. It is not affiliated with, endorsed by, or connected to Rec
> Room Inc. "Rec Room" is a trademark of its respective owner.

## Why?

There are already so many multiplayer clones, why?

1. None of them are fully open source (some had leaks of old code).
2. None of them run on microservice architecture, most on a single server.
3. None of them had unit tests, so servers are constantly buggy.
4. "Upgrading the server" is not sustainable plan for growth.
5. This was fun (sort of). The goal was to build a project that everyone could use. No gatekeeping or viruses.

# Infrastructure

RecFlare uses a true microservice architecture which is infinitely scalable
and could support the same number of concurrent users as the original game. It
will never run out of CPU, memory, or disk space.

Of course, cloud services cost money. That's the only limitation. So we'll see!

And being truly open source means that this project should have more eyes on it,
resulting in bugs getting fixed faster. I hope.

## Game client

Campfire targets the June 2024 PC build `20240621` (Steam depot manifest
`5652464073904128818`). It is the only build accepted by the version check.
Full protocol and room compatibility are still being verified; passing the version
check alone does not mean a saved room can be loaded by this client.

## Services

See [SERVICES.md](SERVICES.md)

## Deploying

Want to run it yourself? See [DEPLOYING.md](DEPLOYING.md)

## FAQ

### What year is this for?

The target is the June 2024 client (`20240621`). Other builds are rejected by the
version check.

See the "Game client" section above for instructions on how to modify a client to connect to this server.

### Can I run this locally on my PC?

It's not currently supported. But theoretically, you could.

See "Run the development microservices" above. It may be possible later as Wrangler will mock remote services. YMMV for now.

### Can I use this to make my own server?

Yes, that's the point. See [DEPLOYING.md](DEPLOYING.md)

### Is there an admin panel?

Yes, the server comes bundled with a simple web panel with more functionality being added.

There are also [CLI tools](CLI.md) you can use for admin tasks like granting roles.

### Can I copy this project and modify it?

Yes, see the [LICENSE](LICENSE).

I would love if you contributed your changes back.

### Why a monorepo?

The services share types, auth logic, and tooling, so keeping them in one repo
keeps those in sync: `pnpm` workspaces share dependencies, `@repo/` packages
share code, Turborepo runs build/test/lint with a single cached task graph, and
cross-service changes land in one atomic commit.

This makes it easier to deploy the whole stack at once or a smaller selection
of microservices to avoid downtime events.

## Credits

I started this soon after the official servers shut down when I saw there were
only monolithic servers usually running on one server. I could only see the
request shapes coming from the game client. I used many different projects as
resources to get response shapes, logic examples, enums, etc. They all had
missing pieces. Again, another reason to come together on one project and
stop gatekeeping.

- [CannedNet](https://github.com/CannedNet/CannedNet)
- [DorkNet](https://github.com/DorkSquadRR/DorkNet)
- jordanparki7's postman collection of RecNet APIs which is gone for some reason.
- Leaked C# projects I won't list (for response shapes)
- Claude and my [wire shapes skill](https://github.com/recflare/skills/blob/main/.claude/skills/wire-shapes/SKILL.md)
