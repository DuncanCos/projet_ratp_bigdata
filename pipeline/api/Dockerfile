FROM python:3.12-slim
COPY requirements.txt /requirements.txt
RUN pip install --no-cache-dir -r /requirements.txt
WORKDIR /app
ENV PYTHONPATH=/opt/lib
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
