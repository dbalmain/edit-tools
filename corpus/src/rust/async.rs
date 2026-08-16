async fn load_documents(client: Client, paths: Vec<Path>) -> Result<Vec<Document>, Error> {
    let mut documents = Vec::new();
    for path in paths {
        let response = client.fetch(&path).await?;
        let document = response.decode().await?;
        documents.push(document);
    }
    // Await points and the loop block are both layout boundaries.
    Ok(documents)
}
