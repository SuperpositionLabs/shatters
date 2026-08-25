// Package migrations embeds the versioned SQL migration files so the server
// binary carries its own schema history.
package migrations

import "embed"

// FS holds all NNNNNN_name.up.sql / .down.sql files at its root.
//
//go:embed *.sql
var FS embed.FS
