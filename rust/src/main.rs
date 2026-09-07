mod auth;
mod import;
mod index;
mod retention;
mod tokenizer;

use anyhow::Result;
use clap::{Parser, Subcommand};
use std::{
    io::{self, Read, Write},
    path::PathBuf,
};

#[derive(Parser)]
#[command(version, about = "Native archive indexing and search")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Auth,
    Import {
        #[arg(long)]
        db: PathBuf,
    },
    /// Read a search request as JSON on stdin and emit a complete JSON response.
    Search {
        #[arg(long)]
        db: PathBuf,
        #[arg(long)]
        index: PathBuf,
    },
}

fn run() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Auth => auth::route(io::stdin().lock(), io::stdout().lock())?,
        Command::Import { db } => import::apply(&db, io::stdin().lock(), io::stdout().lock())?,
        Command::Search { db, index } => {
            let mut input = String::new();
            io::stdin().read_to_string(&mut input)?;
            let request = serde_json::from_str(&input)?;
            let result = index::search(&db, &index, &request)?;
            let mut output = io::BufWriter::new(io::stdout().lock());
            serde_json::to_writer(&mut output, &result)?;
            writeln!(output)?;
            output.flush()?;
        }
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{}", serde_json::json!({ "error": error.to_string() }));
        std::process::exit(1);
    }
}
