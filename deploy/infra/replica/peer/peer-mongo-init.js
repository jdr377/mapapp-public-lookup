const password = process.env.MAPAPP_PEER_MONGO_PASSWORD;
if (!/^[a-f0-9]{64}$/.test(password ?? "")) throw Error("Invalid discovery database password");
db.getSiblingDB("mapapp_peer_discovery").createUser({
  user: "peer_operator",
  pwd: password,
  roles: [{ role: "readWrite", db: "mapapp_peer_discovery" }],
});
