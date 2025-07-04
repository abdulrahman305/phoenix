# Evaluate an Agent

This notebook serves as an end-to-end example of how to trace and evaluate an agent. The example uses a "talk-to-your-data" agent as its example.

The notebook shows examples of:

* Manually instrumenting an agent using Phoenix decorators
* Evaluating function calling accuracy using LLM as a Judge
* Evaluating function calling accuracy by comparing to ground truth
* Evaluating SQL query generation
* Evaluating Python code generation
* Evaluating the path of an agent

{% embed url="https://colab.research.google.com/github/Arize-ai/phoenix/blob/main/tutorials/evals/evaluate_agent.ipynb" %}
View in colab
{% endembed %}

### Install Dependencies, Import Libraries, Set API Keys

```python
!pip install -q openai "arize-phoenix>=8.8.0" "arize-phoenix-otel>=0.8.0" openinference-instrumentation-openai python-dotenv duckdb "openinference-instrumentation>=0.1.21"
```

```python
import dotenv

dotenv.load_dotenv()

import json
import os
from getpass import getpass

import duckdb
import pandas as pd
from IPython.display import Markdown
from openai import OpenAI
from openinference.instrumentation import (
    suppress_tracing,
)
from openinference.instrumentation.openai import OpenAIInstrumentor
from opentelemetry.trace import StatusCode
from pydantic import BaseModel, Field
from tqdm import tqdm

from phoenix.otel import register
```

```python
if os.getenv("OPENAI_API_KEY") is None:
    os.environ["OPENAI_API_KEY"] = getpass("Enter your OpenAI API key: ")

client = OpenAI()
model = "gpt-4o-mini"
project_name = "talk-to-your-data-agent"
```

## Enable Phoenix Tracing

Sign up for a free instance of [Phoenix Cloud](https://app.phoenix.arize.com) to get your API key. If you'd prefer, you can instead [self-host Phoenix](https://arize.com/docs/phoenix/deployment).

```python
if os.getenv("PHOENIX_API_KEY") is None:
    os.environ["PHOENIX_API_KEY"] = getpass("Enter your Phoenix API key: ")

os.environ["PHOENIX_COLLECTOR_ENDPOINT"] = "https://app.phoenix.arize.com/"
os.environ["PHOENIX_CLIENT_HEADERS"] = f"api_key={os.getenv('PHOENIX_API_KEY')}"
```

```python
tracer_provider = register(
    project_name=project_name,
)

OpenAIInstrumentor().instrument(tracer_provider=tracer_provider)

tracer = tracer_provider.get_tracer(__name__)
```

### Prepare dataset

Your agent will interact with a local database. Start by loading in that data:

```python
store_sales_df = pd.read_parquet(
    "https://storage.googleapis.com/arize-phoenix-assets/datasets/unstructured/llm/llama-index/Store_Sales_Price_Elasticity_Promotions_Data.parquet"
)
store_sales_df.head()
```

### Define the tools

Now you can define your agent tools.

#### Tool 1: Database Lookup

````python
SQL_GENERATION_PROMPT = """
Generate an SQL query based on a prompt. Do not reply with anything besides the SQL query.
The prompt is: {prompt}

The available columns are: {columns}
The table name is: {table_name}
"""


def generate_sql_query(prompt: str, columns: list, table_name: str) -> str:
    """Generate an SQL query based on a prompt"""
    formatted_prompt = SQL_GENERATION_PROMPT.format(
        prompt=prompt, columns=columns, table_name=table_name
    )

    response = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": formatted_prompt}],
    )

    return response.choices[0].message.content


@tracer.tool()
def lookup_sales_data(prompt: str) -> str:
    """Implementation of sales data lookup from parquet file using SQL"""
    try:
        table_name = "sales"
        # Read the parquet file into a DuckDB table
        duckdb.sql(f"CREATE TABLE IF NOT EXISTS {table_name} AS SELECT * FROM store_sales_df")

        print(store_sales_df.columns)
        print(table_name)
        sql_query = generate_sql_query(prompt, store_sales_df.columns, table_name)
        sql_query = sql_query.strip()
        sql_query = sql_query.replace("```sql", "").replace("```", "")

        with tracer.start_as_current_span(
            "execute_sql_query", openinference_span_kind="chain"
        ) as span:
            span.set_input(value=sql_query)

            # Execute the SQL query
            result = duckdb.sql(sql_query).df()
            span.set_output(value=str(result))
            span.set_status(StatusCode.OK)
        return result.to_string()
    except Exception as e:
        return f"Error accessing data: {str(e)}"
````

```python
example_data = lookup_sales_data("Show me all the sales for store 1320 on November 1st, 2021")
example_data
```

#### Tool 2: Data Visualization

````python
class VisualizationConfig(BaseModel):
    chart_type: str = Field(..., description="Type of chart to generate")
    x_axis: str = Field(..., description="Name of the x-axis column")
    y_axis: str = Field(..., description="Name of the y-axis column")
    title: str = Field(..., description="Title of the chart")


@tracer.chain()
def extract_chart_config(data: str, visualization_goal: str) -> dict:
    """Generate chart visualization configuration

    Args:
        data: String containing the data to visualize
        visualization_goal: Description of what the visualization should show

    Returns:
        Dictionary containing line chart configuration
    """
    prompt = f"""Generate a chart configuration based on this data: {data}
    The goal is to show: {visualization_goal}"""

    response = client.beta.chat.completions.parse(
        model=model,
        messages=[{"role": "user", "content": prompt}],
        response_format=VisualizationConfig,
    )

    try:
        # Extract axis and title info from response
        content = response.choices[0].message.content

        # Return structured chart config
        return {
            "chart_type": content.chart_type,
            "x_axis": content.x_axis,
            "y_axis": content.y_axis,
            "title": content.title,
            "data": data,
        }
    except Exception:
        return {
            "chart_type": "line",
            "x_axis": "date",
            "y_axis": "value",
            "title": visualization_goal,
            "data": data,
        }


@tracer.chain()
def create_chart(config: VisualizationConfig) -> str:
    """Create a chart based on the configuration"""
    prompt = f"""Write python code to create a chart based on the following configuration.
    Only return the code, no other text.
    config: {config}"""

    response = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": prompt}],
    )

    code = response.choices[0].message.content
    code = code.replace("```python", "").replace("```", "")
    code = code.strip()

    return code


@tracer.tool()
def generate_visualization(data: str, visualization_goal: str) -> str:
    """Generate a visualization based on the data and goal"""
    config = extract_chart_config(data, visualization_goal)
    code = create_chart(config)
    return code
````

```python
# code = generate_visualization(example_data, "A line chart of sales over each day in november.")
```

```python
@tracer.tool()
def run_python_code(code: str) -> str:
    """Execute Python code in a restricted environment"""
    # Create restricted globals/locals dictionaries with plotting libraries
    restricted_globals = {
        "__builtins__": {
            "print": print,
            "len": len,
            "range": range,
            "sum": sum,
            "min": min,
            "max": max,
            "int": int,
            "float": float,
            "str": str,
            "list": list,
            "dict": dict,
            "tuple": tuple,
            "set": set,
            "round": round,
            "__import__": __import__,
            "json": __import__("json"),
        },
        "plt": __import__("matplotlib.pyplot"),
        "pd": __import__("pandas"),
        "np": __import__("numpy"),
        "sns": __import__("seaborn"),
    }

    try:
        # Execute code in restricted environment
        exec_locals = {}
        exec(code, restricted_globals, exec_locals)

        # Capture any printed output or return the plot
        exec_locals.get("__builtins__", {}).get("_", "")
        if "plt" in exec_locals:
            return exec_locals["plt"]

        # Try to parse output as JSON before returning
        return "Code executed successfully"

    except Exception as e:
        return f"Error executing code: {str(e)}"
```

#### Tool 3: Data Analysis

```python
@tracer.tool()
def analyze_sales_data(prompt: str, data: str) -> str:
    """Implementation of AI-powered sales data analysis"""
    # Construct prompt based on analysis type and data subset
    prompt = f"""Analyze the following data: {data}
    Your job is to answer the following question: {prompt}"""

    response = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": prompt}],
    )

    analysis = response.choices[0].message.content
    return analysis if analysis else "No analysis could be generated"
```

```python
# analysis = analyze_sales_data("What is the most popular product SKU?", example_data)
# analysis

```

#### Tool Schema:

You'll need to pass your tool descriptions into your agent router. The following code allows you to easily do so:

```python
# Define tools/functions that can be called by the model
tools = [
    {
        "type": "function",
        "function": {
            "name": "lookup_sales_data",
            "description": "Look up data from Store Sales Price Elasticity Promotions dataset",
            "parameters": {
                "type": "object",
                "properties": {
                    "prompt": {
                        "type": "string",
                        "description": "The unchanged prompt that the user provided.",
                    }
                },
                "required": ["prompt"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "analyze_sales_data",
            "description": "Analyze sales data to extract insights",
            "parameters": {
                "type": "object",
                "properties": {
                    "data": {
                        "type": "string",
                        "description": "The lookup_sales_data tool's output.",
                    },
                    "prompt": {
                        "type": "string",
                        "description": "The unchanged prompt that the user provided.",
                    },
                },
                "required": ["data", "prompt"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "generate_visualization",
            "description": "Generate Python code to create data visualizations",
            "parameters": {
                "type": "object",
                "properties": {
                    "data": {
                        "type": "string",
                        "description": "The lookup_sales_data tool's output.",
                    },
                    "visualization_goal": {
                        "type": "string",
                        "description": "The goal of the visualization.",
                    },
                },
                "required": ["data", "visualization_goal"],
            },
        },
    },
    # {
    #     "type": "function",
    #     "function": {
    #         "name": "run_python_code",
    #         "description": "Run Python code in a restricted environment",
    #         "parameters": {
    #             "type": "object",
    #             "properties": {
    #                 "code": {"type": "string", "description": "The Python code to run."}
    #             },
    #             "required": ["code"]
    #         }
    #     }
    # }
]

# Dictionary mapping function names to their implementations
tool_implementations = {
    "lookup_sales_data": lookup_sales_data,
    "analyze_sales_data": analyze_sales_data,
    "generate_visualization": generate_visualization,
    # "run_python_code": run_python_code
}
```

### Agent logic

With the tools defined, you're ready to define the main routing and tool call handling steps of your agent.

```python
@tracer.chain()
def handle_tool_calls(tool_calls, messages):
    for tool_call in tool_calls:
        function = tool_implementations[tool_call.function.name]
        function_args = json.loads(tool_call.function.arguments)
        result = function(**function_args)

        messages.append({"role": "tool", "content": result, "tool_call_id": tool_call.id})
    return messages
```

```python
def start_main_span(messages):
    print("Starting main span with messages:", messages)

    with tracer.start_as_current_span("AgentRun", openinference_span_kind="agent") as span:
        span.set_input(value=messages)
        ret = run_agent(messages)
        print("Main span completed with return value:", ret)
        span.set_output(value=ret)
        span.set_status(StatusCode.OK)
        return ret


def run_agent(messages):
    print("Running agent with messages:", messages)
    if isinstance(messages, str):
        messages = [{"role": "user", "content": messages}]
        print("Converted string message to list format")

    # Check and add system prompt if needed
    if not any(
        isinstance(message, dict) and message.get("role") == "system" for message in messages
    ):
        system_prompt = {
            "role": "system",
            "content": "You are a helpful assistant that can answer questions about the Store Sales Price Elasticity Promotions dataset.",
        }
        messages.append(system_prompt)
        print("Added system prompt to messages")

    while True:
        # Router call span
        print("Starting router call span")
        with tracer.start_as_current_span(
            "router_call",
            openinference_span_kind="chain",
        ) as span:
            span.set_input(value=messages)

            response = client.chat.completions.create(
                model=model,
                messages=messages,
                tools=tools,
            )

            messages.append(response.choices[0].message.model_dump())
            tool_calls = response.choices[0].message.tool_calls
            print("Received response with tool calls:", bool(tool_calls))
            span.set_status(StatusCode.OK)

            if tool_calls:
                # Tool calls span
                print("Processing tool calls")
                messages = handle_tool_calls(tool_calls, messages)
                span.set_output(value=tool_calls)
            else:
                print("No tool calls, returning final response")
                span.set_output(value=response.choices[0].message.content)

                return response.choices[0].message.content
```

### Run the agent

Your agent is now good to go! Let's try it out with some example questions:

```python
ret = start_main_span([{"role": "user", "content": "Create a line chart showing sales in 2021"}])
print(Markdown(ret))
```

```python
agent_questions = [
    "What was the most popular product SKU?",
    "What was the total revenue across all stores?",
    "Which store had the highest sales volume?",
    "Create a bar chart showing total sales by store",
    "What percentage of items were sold on promotion?",
    "Plot daily sales volume over time",
    "What was the average transaction value?",
    "Create a box plot of transaction values",
    "Which products were frequently purchased together?",
    "Plot a line graph showing the sales trend over time with a 7-day moving average",
]

for question in tqdm(agent_questions, desc="Processing questions"):
    try:
        ret = start_main_span([{"role": "user", "content": question}])
    except Exception as e:
        print(f"Error processing question: {question}")
        print(e)
        continue
```

![Agent Traces](https://storage.googleapis.com/arize-phoenix-assets/assets/images/agent-traces.png)

## Evaluating the agent

So your agent looks like it's working, but how can you measure its performance?

```python
OpenAIInstrumentor().uninstrument()  # Uninstrument the OpenAI client to avoid capturing LLM as a Judge evaluation calls in your same project.
```

```python
import nest_asyncio

import phoenix as px
from phoenix.evals import TOOL_CALLING_PROMPT_TEMPLATE, OpenAIModel, llm_classify
from phoenix.experiments import evaluate_experiment, run_experiment
from phoenix.experiments.evaluators import create_evaluator
from phoenix.experiments.types import Example
from phoenix.trace import SpanEvaluations
from phoenix.trace.dsl import SpanQuery

nest_asyncio.apply()
```

```python
px_client = px.Client()
eval_model = OpenAIModel(model="gpt-4o-mini")
```

### Function Calling Evals using LLM as a Judge

This first evaluation will evaluate your agent router choices using another LLM.

It follows a standard pattern:

1. Export traces from Phoenix
2. Prepare those exported traces in a dataframe with the correct columns
3. Use `llm_classify` to run a standard template across each row of that dataframe and produce an eval label
4. Upload the results back into Phoenix

```python
query = (
    SpanQuery()
    .where(
        "span_kind == 'LLM'",
    )
    .select(question="input.value", output_messages="llm.output_messages")
)

# The Phoenix Client can take this query and return the dataframe.
tool_calls_df = px.Client().query_spans(query, project_name=project_name, timeout=None)
tool_calls_df.dropna(subset=["output_messages"], inplace=True)


def get_tool_call(outputs):
    if outputs[0].get("message").get("tool_calls"):
        return (
            outputs[0]
            .get("message")
            .get("tool_calls")[0]
            .get("tool_call")
            .get("function")
            .get("name")
        )
    else:
        return "No tool used"


tool_calls_df["tool_call"] = tool_calls_df["output_messages"].apply(get_tool_call)
tool_calls_df.head()
```

```python
tool_call_eval = llm_classify(
    dataframe=tool_calls_df,
    template=TOOL_CALLING_PROMPT_TEMPLATE.template.replace(
        "{tool_definitions}",
        "generate_visualization, lookup_sales_data, analyze_sales_data, run_python_code",
    ),
    rails=["correct", "incorrect"],
    model=eval_model,
    provide_explanation=True,
)

tool_call_eval["score"] = tool_call_eval.apply(
    lambda x: 1 if x["label"] == "correct" else 0, axis=1
)

tool_call_eval.head()
```

```python
px.Client().log_evaluations(
    SpanEvaluations(eval_name="Tool Calling Eval", dataframe=tool_call_eval),
)
```

You should now see eval labels in Phoenix.

<figure><img src="https://storage.googleapis.com/arize-phoenix-assets/assets/images/function-calling-evals.png" alt=""><figcaption></figcaption></figure>

#### Function Calling Evals using Ground Truth

The above example works, however if you have ground truth labled data, you can use that data to get an even more accurate measure of your router's performance by running an experiments.

Experiments also follow a standard step-by-step process in Phoenix:

1. Create a dataset of test cases, and optionally, expected outputs
2. Create a task to run on each test case - usually this is invoking your agent or a specifc step of it
3. Create evaluator(s) to run on each output of your task
4. Visualize results in Phoenix

```python
import uuid

id = str(uuid.uuid4())

agent_tool_responses = {
    "What was the most popular product SKU?": "lookup_sales_data, analyze_sales_data",
    "What was the total revenue across all stores?": "lookup_sales_data, analyze_sales_data",
    "Which store had the highest sales volume?": "lookup_sales_data, analyze_sales_data",
    "Create a bar chart showing total sales by store": "generate_visualization, lookup_sales_data, run_python_code",
    "What percentage of items were sold on promotion?": "lookup_sales_data, analyze_sales_data",
    "Plot daily sales volume over time": "generate_visualization, lookup_sales_data, run_python_code",
    "What was the average transaction value?": "lookup_sales_data, analyze_sales_data",
    "Create a box plot of transaction values": "generate_visualization, lookup_sales_data, run_python_code",
    "Which products were frequently purchased together?": "lookup_sales_data, analyze_sales_data",
    "Plot a line graph showing the sales trend over time with a 7-day moving average": "generate_visualization, lookup_sales_data, run_python_code",
}


tool_calling_df = pd.DataFrame(agent_tool_responses.items(), columns=["question", "tool_calls"])
dataset = px_client.upload_dataset(
    dataframe=tool_calling_df,
    dataset_name=f"tool_calling_ground_truth_{id}",
    input_keys=["question"],
    output_keys=["tool_calls"],
)
```

For your task, you can simply run just the router call of your agent:

```python
def run_router_step(example: Example) -> str:
    messages = [
        {
            "role": "system",
            "content": "You are a helpful assistant that can answer questions about the Store Sales Price Elasticity Promotions dataset.",
        }
    ]
    messages.append({"role": "user", "content": example.input.get("question")})

    response = client.chat.completions.create(
        model=model,
        messages=messages,
        tools=tools,
    )
    tool_calls = []
    for tool_call in response.choices[0].message.tool_calls:
        tool_calls.append(tool_call.function.name)
    return tool_calls
```

Your evaluator can also be simple, since you have expected outputs. If you didn't have those expected outputs, you could instead use an LLM as a Judge here, or even basic code:

```python
def tools_match(expected: str, output: str) -> bool:
    expected_tools = expected.get("tool_calls").split(", ")
    return expected_tools == output
```

```python
experiment = run_experiment(
    dataset,
    run_router_step,
    evaluators=[tools_match],
    experiment_name="Tool Calling Eval",
    experiment_description="Evaluating the tool calling step of the agent",
)
```

### Tool Evals

The next piece of your agent to evaluate is its tools. Each tool is usually evaluated differently - we've included some examples below. If you need other ideas, [Phoenix's built-in evaluators](https://arize.com/docs/phoenix/evaluation/how-to-evals/running-pre-tested-evals) give you an idea of other metrics to use.

#### Evaluating our SQL generation tool

```python
# This step will be replaced by a human annotated set of ground truth data, instead of generated examples

db_lookup_questions = [
    "What was the most popular product SKU?",
    "Which store had the highest total sales value?",
    "How many items were sold on promotion?",
    "What was the average quantity sold per transaction?",
    "Which product class code generated the most revenue?",
    "What day of the week had the highest sales volume?",
    "How many unique stores made sales?",
    "What was the highest single transaction value?",
    "Which products were frequently sold together?",
    "What's the trend in sales over time?",
]

expected_results = []

for question in tqdm(db_lookup_questions, desc="Processing SQL lookup questions"):
    try:
        with suppress_tracing():
            expected_results.append(lookup_sales_data(question))
    except Exception as e:
        print(f"Error processing question: {question}")
        print(e)
        db_lookup_questions.remove(question)

# Create a DataFrame with the questions
questions_df = pd.DataFrame({"question": db_lookup_questions, "expected_result": expected_results})

display(questions_df)
```

```python
dataset = px_client.upload_dataset(
    dataframe=questions_df,
    dataset_name=f"sales_db_lookup_questions_{id}",
    input_keys=["question"],
    output_keys=["expected_result"],
)
```

```python
def run_sql_query(example: Example) -> str:
    with suppress_tracing():
        return lookup_sales_data(example.input.get("question"))
```

```python
def evaluate_sql_result(output: str, expected: str) -> bool:
    # Extract just the numbers from both strings
    result_nums = "".join(filter(str.isdigit, output))
    expected_nums = "".join(filter(str.isdigit, expected.get("expected_result")))
    return result_nums == expected_nums
```

```python
experiment = run_experiment(
    dataset,
    run_sql_query,
    evaluators=[evaluate_sql_result],
    experiment_name="SQL Query Eval",
    experiment_description="Evaluating the SQL query generation step of the agent",
)
```

#### Evaluating our Python code generation tool

```python
# Replace this with a human annotated set of ground truth data, instead of generated examples

code_generation_questions = [
    "Create a bar chart showing total sales by store",
    "Plot daily sales volume over time",
    "Plot a line graph showing the sales trend over time with a 7-day moving average",
    "Create a histogram of quantities sold per transaction",
    "Generate a pie chart showing sales distribution across product classes",
    "Create a stacked bar chart showing promotional vs non-promotional sales by store",
    "Generate a heatmap of sales by day of week and store number",
    "Plot a line chart comparing sales trends between top 5 stores",
]

example_data = []
chart_configs = []
for question in tqdm(code_generation_questions[:], desc="Processing code generation questions"):
    try:
        with suppress_tracing():
            example_data.append(lookup_sales_data(question))
            chart_configs.append(json.dumps(extract_chart_config(example_data[-1], question)))
    except Exception as e:
        print(f"Error processing question: {question}")
        print(e)
        code_generation_questions.remove(question)

code_generation_df = pd.DataFrame(
    {
        "question": code_generation_questions,
        "example_data": example_data,
        "chart_configs": chart_configs,
    }
)

dataset = px_client.upload_dataset(
    dataframe=code_generation_df,
    dataset_name=f"code_generation_questions_{id}",
    input_keys=["question", "example_data", "chart_configs"],
)
```

```python
def run_code_generation(example: Example) -> str:
    with suppress_tracing():
        chart_config = extract_chart_config(
            data=example.input.get("example_data"), visualization_goal=example.input.get("question")
        )
        code = generate_visualization(
            visualization_goal=example.input.get("question"), data=example.input.get("example_data")
        )

    return {"code": code, "chart_config": chart_config}
```

In this case, you don't have ground truth data to compare to. Instead you can just use a simple code evaluator: trying to run the generated code and catching any errors.

````python
def code_is_runnable(output: str) -> bool:
    """Check if the code is runnable"""
    output = output.get("code")
    output = output.strip()
    output = output.replace("```python", "").replace("```", "")
    try:
        exec(output)
        return True
    except Exception:
        return False
````

```python
def evaluate_chart_config(output: str, expected: str) -> bool:
    return output.get("chart_config") == expected.get("chart_config")
```

```python
experiment = run_experiment(
    dataset,
    run_code_generation,
    evaluators=[code_is_runnable, evaluate_chart_config],
    experiment_name="Code Generation Eval",
    experiment_description="Evaluating the code generation step of the agent",
)
```

## Evaluating the agent path and convergence

Finally, the last piece of your agent to evaluate is its path. This is important to evaluate to understand how efficient your agent is in its execution. Does it need to call the same tool multiple times? Does it skip steps it shouldn't, and have to backtrack later? Convergence or path evals can tell you this.

Convergence evals operate slightly differently. The one you'll use below relies on knowing the minimum number of steps taken by the agent for a given type of query. Instead of just running an experiment, you'll run an experiment then after it completes, attach a second evaluator to calculate convergence.

The workflow is as follows:

1. Create a dataset of the same type of question, phrased different ways each time - the agent should take the same path for each, but you'll often find it doesn't.
2. Create a task that runs the agent on each question, while tracking the number of steps it takes.
3. Run the experiment without an evaluator.
4. Calculate the minimum number of steps taken to complete the task.
5. Create an evaluator that compares the steps taken of each run against that min step number.
6. Run this evaluator on your experiment from step 3.
7. View your results in Phoenix

```python
# Replace this with a human annotated set of ground truth data, instead of generated examples

convergence_questions = [
    "What was the average quantity sold per transaction?",
    "What is the mean number of items per sale?",
    "Calculate the typical quantity per transaction",
    "Show me the average number of units sold in each transaction",
    "What's the mean transaction size in terms of quantity?",
    "On average, how many items were purchased per transaction?",
    "What is the average basket size per sale?",
    "Calculate the mean number of products per purchase",
    "What's the typical number of units per order?",
    "Find the average quantity of items in each transaction",
    "What is the average number of products bought per purchase?",
    "Tell me the mean quantity of items in a typical transaction",
    "How many items does a customer buy on average per transaction?",
    "What's the usual number of units in each sale?",
    "Calculate the average basket quantity per order",
    "What is the typical amount of products per transaction?",
    "Show the mean number of items customers purchase per visit",
    "What's the average quantity of units per shopping trip?",
    "How many products do customers typically buy in one transaction?",
    "What is the standard basket size in terms of quantity?",
]

convergence_df = pd.DataFrame({"question": convergence_questions})

dataset = px_client.upload_dataset(
    dataframe=convergence_df, dataset_name="convergence_questions", input_keys=["question"]
)
```

```python
def format_message_steps(messages):
    """
    Convert a list of message objects into a readable format that shows the steps taken.

    Args:
        messages (list): A list of message objects containing role, content, tool calls, etc.

    Returns:
        str: A readable string showing the steps taken.
    """
    steps = []
    for message in messages:
        role = message.get("role")
        if role == "user":
            steps.append(f"User: {message.get('content')}")
        elif role == "system":
            steps.append("System: Provided context")
        elif role == "assistant":
            if message.get("tool_calls"):
                for tool_call in message["tool_calls"]:
                    tool_name = tool_call["function"]["name"]
                    steps.append(f"Assistant: Called tool '{tool_name}'")
            else:
                steps.append(f"Assistant: {message.get('content')}")
        elif role == "tool":
            steps.append(f"Tool response: {message.get('content')}")

    return "\n".join(steps)
```

```python
def run_agent_and_track_path(example: Example) -> str:
    print("Starting main span with messages:", example.input.get("question"))
    messages = [{"role": "user", "content": example.input.get("question")}]
    ret = run_agent_messages(messages)
    return {"path_length": len(ret), "messages": format_message_steps(ret)}


def run_agent_messages(messages):
    print("Running agent with messages:", messages)
    if isinstance(messages, str):
        messages = [{"role": "user", "content": messages}]
        print("Converted string message to list format")

    # Check and add system prompt if needed
    if not any(
        isinstance(message, dict) and message.get("role") == "system" for message in messages
    ):
        system_prompt = {
            "role": "system",
            "content": "You are a helpful assistant that can answer questions about the Store Sales Price Elasticity Promotions dataset.",
        }
        messages.append(system_prompt)
        print("Added system prompt to messages")

    while True:
        # Router call span
        print("Starting router")

        response = client.chat.completions.create(
            model=model,
            messages=messages,
            tools=tools,
        )

        messages.append(response.choices[0].message.model_dump())
        tool_calls = response.choices[0].message.tool_calls
        print("Received response with tool calls:", bool(tool_calls))

        if tool_calls:
            # Tool calls span
            print("Processing tool calls")
            tool_calls = response.choices[0].message.tool_calls
            messages = handle_tool_calls(tool_calls, messages)
        else:
            print("No tool calls, returning final response")
            return messages
```

```python
experiment = run_experiment(
    dataset,
    run_agent_and_track_path,
    experiment_name="Convergence Eval",
    experiment_description="Evaluating the convergence of the agent",
)
```

```python
experiment.as_dataframe()
```

```python
outputs = experiment.as_dataframe()["output"].to_dict().values()
optimal_path_length = min(
    output.get("path_length")
    for output in outputs
    if output and output.get("path_length") is not None
)
print(f"The optimal path length is {optimal_path_length}")
```

```python
@create_evaluator(name="Convergence Eval", kind="CODE")
def evaluate_path_length(output: str) -> float:
    if output and output.get("path_length"):
        return optimal_path_length / float(output.get("path_length"))
    else:
        return 0
```

```python
experiment = evaluate_experiment(experiment, evaluators=[evaluate_path_length])
```

## Advanced - Combining all the evals into our experiment

As an optional final step, you can combine all the evaluators and experiments above into a single experiment. This requires some more advanced data wrangling, but gives you a single report on your agent's performance.

#### Build a version of our agent that tracks all the necessary information for evals

```python
def process_messages(messages):
    tool_calls = []
    tool_responses = []
    final_output = None

    for i, message in enumerate(messages):
        # Extract tool calls
        if "tool_calls" in message and message["tool_calls"]:
            for tool_call in message["tool_calls"]:
                tool_name = tool_call["function"]["name"]
                tool_input = tool_call["function"]["arguments"]
                tool_calls.append(tool_name)

                # Prepare tool response structure with tool name and input
                tool_responses.append(
                    {"tool_name": tool_name, "tool_input": tool_input, "tool_response": None}
                )

        # Extract tool responses
        if message["role"] == "tool" and "tool_call_id" in message:
            for tool_response in tool_responses:
                if message["tool_call_id"] in message.values():
                    tool_response["tool_response"] = message["content"]

        # Extract final output
        if (
            message["role"] == "assistant"
            and not message.get("tool_calls")
            and not message.get("function_call")
        ):
            final_output = message["content"]

    result = {
        "tool_calls": tool_calls,
        "tool_responses": tool_responses,
        "final_output": final_output,
        "unchanged_messages": messages,
        "path_length": len(messages),
    }

    return result
```

```python
def run_agent_and_track_path_combined(example: Example) -> str:
    print("Starting main span with messages:", example.input.get("question"))
    messages = [{"role": "user", "content": example.input.get("question")}]
    ret = run_agent_messages_combined(messages)
    return process_messages(ret)


def run_agent_messages_combined(messages):
    print("Running agent with messages:", messages)
    if isinstance(messages, str):
        messages = [{"role": "user", "content": messages}]
        print("Converted string message to list format")

    # Check and add system prompt if needed
    if not any(
        isinstance(message, dict) and message.get("role") == "system" for message in messages
    ):
        system_prompt = {
            "role": "system",
            "content": "You are a helpful assistant that can answer questions about the Store Sales Price Elasticity Promotions dataset.",
        }
        messages.append(system_prompt)
        print("Added system prompt to messages")

    while True:
        # Router call span
        print("Starting router")

        response = client.chat.completions.create(
            model=model,
            messages=messages,
            tools=tools,
        )

        messages.append(response.choices[0].message.model_dump())
        tool_calls = response.choices[0].message.tool_calls
        print("Received response with tool calls:", bool(tool_calls))

        if tool_calls:
            # Tool calls span
            print("Processing tool calls")
            tool_calls = response.choices[0].message.tool_calls
            messages = handle_tool_calls(tool_calls, messages)
        else:
            print("No tool calls, returning final response")
            return messages
```

```python
generate_sql_query("What was the most popular product SKU?", store_sales_df.columns, "sales")
```

```python
overall_experiment_questions = [
    {
        "question": "What was the most popular product SKU?",
        "sql_result": "   SKU_Coded  Total_Qty_Sold 0    6200700         52262.0",
    },
    {
        "question": "What was the total revenue across all stores?",
        "sql_result": "   Total_Revenue 0   1.327264e+07",
    },
    {
        "question": "Which store had the highest sales volume?",
        "sql_result": "   Store_Number  Total_Sales_Volume 0          2970             59322.0",
    },
    {
        "question": "Create a bar chart showing total sales by store",
        "sql_result": "    Store_Number    Total_Sales 0            880  420302.088397 1           1650  580443.007953 2           4180  272208.118542 3            550  229727.498752 4           1100  497509.528013 5           3300  619660.167018 6           3190  335035.018792 7           2970  836341.327191 8           3740  359729.808228 9           2530  324046.518720 10          4400   95745.620250 11          1210  508393.767785 12           330  370503.687331 13          2750  453664.808068 14          1980  242290.828499 15          1760  350747.617798 16          3410  410567.848126 17           990  378433.018639 18          4730  239711.708869 19          4070  322307.968330 20          3080  495458.238811 21          2090  309996.247965 22          1320  592832.067579 23          2640  308990.318559 24          1540  427777.427815 25          4840  389056.668316 26          2860  132320.519487 27          2420  406715.767402 28           770  292968.918642 29          3520  145701.079372 30           660  343594.978075 31          3630  405034.547846 32          2310  412579.388504 33          2200  361173.288199 34          1870  401070.997685",
    },
    {
        "question": "What percentage of items were sold on promotion?",
        "sql_result": "   Promotion_Percentage 0              0.625596",
    },
    {
        "question": "What was the average transaction value?",
        "sql_result": "   Average_Transaction_Value 0                  19.018132",
    },
    {
        "question": "Create a line chart showing sales in 2021",
        "sql_result": "  sale_month  total_quantity_sold  total_sales_value 0 2021-11-01              43056.0      499984.428193 1 2021-12-01              75724.0      910982.118423",
    },
]

overall_experiment_questions[0]["sql_generated"] = generate_sql_query(
    overall_experiment_questions[0]["question"], store_sales_df.columns, "sales"
)
overall_experiment_questions[1]["sql_generated"] = generate_sql_query(
    overall_experiment_questions[1]["question"], store_sales_df.columns, "sales"
)
overall_experiment_questions[2]["sql_generated"] = generate_sql_query(
    overall_experiment_questions[2]["question"], store_sales_df.columns, "sales"
)
overall_experiment_questions[3]["sql_generated"] = generate_sql_query(
    overall_experiment_questions[3]["question"], store_sales_df.columns, "sales"
)
overall_experiment_questions[4]["sql_generated"] = generate_sql_query(
    overall_experiment_questions[4]["question"], store_sales_df.columns, "sales"
)
overall_experiment_questions[5]["sql_generated"] = generate_sql_query(
    overall_experiment_questions[5]["question"], store_sales_df.columns, "sales"
)
overall_experiment_questions[6]["sql_generated"] = generate_sql_query(
    overall_experiment_questions[6]["question"], store_sales_df.columns, "sales"
)

print(overall_experiment_questions[6])

# overall_experiment_df = pd.DataFrame(overall_experiment_questions)

# dataset = px_client.upload_dataset(dataframe=overall_experiment_df, dataset_name="overall_experiment_questions_all", input_keys=["question"], output_keys=["sql_result"])
```

```python
print(overall_experiment_questions[6])
```

````python
[
    {
        "question": "What was the most popular product SKU?",
        "sql_result": "   SKU_Coded  Total_Qty_Sold 0    6200700         52262.0",
        "sql_generated": "```sql\nSELECT SKU_Coded, SUM(Qty_Sold) AS Total_Qty_Sold\nFROM sales\nGROUP BY SKU_Coded\nORDER BY Total_Qty_Sold DESC\nLIMIT 1;\n```",
    },
    {
        "question": "What was the total revenue across all stores?",
        "sql_result": "   Total_Revenue 0   1.327264e+07",
        "sql_generated": "```sql\nSELECT SUM(Total_Sale_Value) AS Total_Revenue\nFROM sales;\n```",
    },
    {
        "question": "Which store had the highest sales volume?",
        "sql_result": "   Store_Number  Total_Sales_Volume 0          2970             59322.0",
        "sql_generated": "```sql\nSELECT Store_Number, SUM(Total_Sale_Value) AS Total_Sales_Volume\nFROM sales\nGROUP BY Store_Number\nORDER BY Total_Sales_Volume DESC\nLIMIT 1;\n```",
    },
    {
        "question": "Create a bar chart showing total sales by store",
        "sql_result": "    Store_Number    Total_Sales 0            880  420302.088397 1           1650  580443.007953 2           4180  272208.118542 3            550  229727.498752 4           1100  497509.528013 5           3300  619660.167018 6           3190  335035.018792 7           2970  836341.327191 8           3740  359729.808228 9           2530  324046.518720 10          4400   95745.620250 11          1210  508393.767785 12           330  370503.687331 13          2750  453664.808068 14          1980  242290.828499 15          1760  350747.617798 16          3410  410567.848126 17           990  378433.018639 18          4730  239711.708869 19          4070  322307.968330 20          3080  495458.238811 21          2090  309996.247965 22          1320  592832.067579 23          2640  308990.318559 24          1540  427777.427815 25          4840  389056.668316 26          2860  132320.519487 27          2420  406715.767402 28           770  292968.918642 29          3520  145701.079372 30           660  343594.978075 31          3630  405034.547846 32          2310  412579.388504 33          2200  361173.288199 34          1870  401070.997685",
        "sql_generated": "```sql\nSELECT Store_Number, SUM(Total_Sale_Value) AS Total_Sales\nFROM sales\nGROUP BY Store_Number;\n```",
    },
    {
        "question": "What percentage of items were sold on promotion?",
        "sql_result": "   Promotion_Percentage 0              0.625596",
        "sql_generated": "```sql\nSELECT \n    (SUM(CASE WHEN On_Promo = 'Yes' THEN 1 ELSE 0 END) * 100.0) / COUNT(*) AS Promotion_Percentage\nFROM \n    sales;\n```",
    },
    {
        "question": "What was the average transaction value?",
        "sql_result": "   Average_Transaction_Value 0                  19.018132",
        "sql_generated": "```sql\nSELECT AVG(Total_Sale_Value) AS Average_Transaction_Value\nFROM sales;\n```",
    },
    {
        "question": "Create a line chart showing sales in 2021",
        "sql_result": "  sale_month  total_quantity_sold  total_sales_value 0 2021-11-01              43056.0      499984.428193 1 2021-12-01              75724.0      910982.118423",
        "sql_generated": "```sql\nSELECT MONTH(Sold_Date) AS Month, SUM(Total_Sale_Value) AS Total_Sales\nFROM sales\nWHERE YEAR(Sold_Date) = 2021\nGROUP BY MONTH(Sold_Date)\nORDER BY MONTH(Sold_Date);\n```",
    },
]
````

```python
CLARITY_LLM_JUDGE_PROMPT = """
In this task, you will be presented with a query and an answer. Your objective is to evaluate the clarity
of the answer in addressing the query. A clear response is one that is precise, coherent, and directly
addresses the query without introducing unnecessary complexity or ambiguity. An unclear response is one
that is vague, disorganized, or difficult to understand, even if it may be factually correct.

Your response should be a single word: either "clear" or "unclear," and it should not include any other
text or characters. "clear" indicates that the answer is well-structured, easy to understand, and
appropriately addresses the query. "unclear" indicates that the answer is ambiguous, poorly organized, or
not effectively communicated. Please carefully consider the query and answer before determining your
response.

After analyzing the query and the answer, you must write a detailed explanation of your reasoning to
justify why you chose either "clear" or "unclear." Avoid stating the final label at the beginning of your
explanation. Your reasoning should include specific points about how the answer does or does not meet the
criteria for clarity.

[BEGIN DATA]
Query: {query}
Answer: {response}
[END DATA]
Please analyze the data carefully and provide an explanation followed by your response.

EXPLANATION: Provide your reasoning step by step, evaluating the clarity of the answer based on the query.
LABEL: "clear" or "unclear"
"""

ENTITY_CORRECTNESS_LLM_JUDGE_PROMPT = """
In this task, you will be presented with a query and an answer. Your objective is to determine whether all
the entities mentioned in the answer are correctly identified and accurately match those in the query. An
entity refers to any specific person, place, organization, date, or other proper noun. Your evaluation
should focus on whether the entities in the answer are correctly named and appropriately associated with
the context in the query.

Your response should be a single word: either "correct" or "incorrect," and it should not include any
other text or characters. "correct" indicates that all entities mentioned in the answer match those in the
query and are properly identified. "incorrect" indicates that the answer contains errors or mismatches in
the entities referenced compared to the query.

After analyzing the query and the answer, you must write a detailed explanation of your reasoning to
justify why you chose either "correct" or "incorrect." Avoid stating the final label at the beginning of
your explanation. Your reasoning should include specific points about how the entities in the answer do or
do not match the entities in the query.

[BEGIN DATA]
Query: {query}
Answer: {response}
[END DATA]
Please analyze the data carefully and provide an explanation followed by your response.

EXPLANATION: Provide your reasoning step by step, evaluating whether the entities in the answer are
correct and consistent with the query.
LABEL: "correct" or "incorrect"
"""
```

```python
TOOL_CALLING_PROMPT_TEMPLATE.template.replace("{tool_definitions}", json.dumps(tools))
```

````python
def function_calling_eval(input: str, output: str) -> float:
    function_calls = output.get("tool_calls")
    if function_calls:
        eval_df = pd.DataFrame(
            {"question": [input.get("question")] * len(function_calls), "tool_call": function_calls}
        )

        tool_call_eval = llm_classify(
            dataframe=eval_df,
            template=TOOL_CALLING_PROMPT_TEMPLATE.template.replace(
                "{tool_definitions}", json.dumps(tools).replace("{", '"').replace("}", '"')
            ),
            rails=["correct", "incorrect"],
            model=eval_model,
            provide_explanation=True,
        )

        tool_call_eval["score"] = tool_call_eval.apply(
            lambda x: 1 if x["label"] == "correct" else 0, axis=1
        )
        return tool_call_eval["score"].mean()
    else:
        return 0


def code_is_runnable(output: str) -> bool:
    """Check if the code is runnable"""
    generated_code = output.get("tool_responses")
    if not generated_code:
        return True

    # Find first lookup_sales_data response
    generated_code = next(
        (r for r in generated_code if r.get("tool_name") == "generate_visualization"), None
    )
    if not generated_code:
        return True

    # Get the first response
    generated_code = generated_code.get("tool_response", "")
    generated_code = generated_code.strip()
    generated_code = generated_code.replace("```python", "").replace("```", "")
    try:
        exec(generated_code)
        return True
    except Exception:
        return False


def evaluate_sql_result(output, expected) -> bool:
    sql_result = output.get("tool_responses")
    if not sql_result:
        return True

    # Find first lookup_sales_data response
    sql_result = next((r for r in sql_result if r.get("tool_name") == "lookup_sales_data"), None)
    if not sql_result:
        return True

    # Get the first response
    sql_result = sql_result.get("tool_response", "")

    # Extract just the numbers from both strings
    result_nums = "".join(filter(str.isdigit, sql_result))
    expected_nums = "".join(filter(str.isdigit, expected.get("sql_result")))
    return result_nums == expected_nums


def evaluate_clarity(output: str, input: str) -> bool:
    df = pd.DataFrame({"query": [input.get("question")], "response": [output.get("final_output")]})
    response = llm_classify(
        dataframe=df,
        template=CLARITY_LLM_JUDGE_PROMPT,
        rails=["clear", "unclear"],
        model=eval_model,
        provide_explanation=True,
    )
    return response["label"] == "clear"


def evaluate_entity_correctness(output: str, input: str) -> bool:
    df = pd.DataFrame({"query": [input.get("question")], "response": [output.get("final_output")]})
    response = llm_classify(
        dataframe=df,
        template=ENTITY_CORRECTNESS_LLM_JUDGE_PROMPT,
        rails=["correct", "incorrect"],
        model=eval_model,
        provide_explanation=True,
    )
    return response["label"] == "correct"
````

```python
def run_overall_experiment(example: Example) -> str:
    with suppress_tracing():
        return run_agent_and_track_path_combined(example)


experiment = run_experiment(
    dataset,
    run_overall_experiment,
    evaluators=[
        function_calling_eval,
        evaluate_sql_result,
        evaluate_clarity,
        evaluate_entity_correctness,
        code_is_runnable,
    ],
    experiment_name="Overall Experiment",
    experiment_description="Evaluating the overall experiment",
)
```

### Congratulations! 🎉

You've now evaluated every aspect of your agent. If you've made it this far, you're now an expert in evaluating agent routers, tools, and paths!

<figure><img src="https://storage.googleapis.com/arize-phoenix-assets/assets/images/combined-agent-experiments.png" alt=""><figcaption></figcaption></figure>
